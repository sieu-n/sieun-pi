// Guards the release owner's case of 10-18: its Mac worker started at 04:29Z, before the cross-host fallback (VERSION 15, 3a7e058), so its
// kernel held the older check and every send to a chat that had moved to us-metal02 failed with No sibling matches until 06:1xZ, while Fable,
// whose worker started at 04:57Z, reached the same chats. The prelude now reads the check file's VERSION at each cell (d116e4fd4), so a
// kernel that installed an older check runs the current one at its next cell.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { otherBoxRoots, type Root, type RootDirectory, sendCrossHost, siblingRow } from "../src/cross-host-message.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const RELEASE_OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const LAUNCH = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const ROOTS: Root[] = [
  { sessionId: RELEASE_OWNER, name: "release owner", host: "mac", status: "working" },
  { sessionId: LAUNCH, name: "***launch main bro***", host: "us-metal02", status: "idle" },
];

test("a kernel that installed an older message check sends to a moved chat across boxes at its next cell", async () => {
  const sent: string[] = [];
  const directory: RootDirectory = { roots: () => ROOTS, send: async (session, text) => {
    sent.push(`${session} ${text}`);
    return { deliveryStatus: "queued", target: { sessionId: session } };
  }, reopen: async () => false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const answer = url.pathname.endsWith("api/agent/siblings")
        ? otherBoxRoots(directory, url.searchParams.get("session")!).then(roots => ({ agents: roots.map(siblingRow) }))
        : (() => { const { from, to, message } = JSON.parse(body); return sendCrossHost(directory, from, to, message); })();
      answer.then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
        error => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "old-kernel-send-"));
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  // The Mac daemon, which runs no root named by the launch chat's id since the move.
  await writeFile(join(dir, "rlm.py"), [
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    "        raise RuntimeError('No sibling matches \"' + payload['receiver_name'] + '\"')",
    "    return {'agents': []}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = [
    "import sys",
    "sys.user_history_message_check = 14",
    messageCheckPrelude(dir).trimEnd(),
    "import asyncio, json, agent_message",
    "async def main():",
    `    print(json.dumps(await agent_message.host_request('agent_message.send', {'message': 'land 37 read-back', 'receiver_role': 'sibling', 'receiver_name': '${LAUNCH}'})))`,
    "asyncio.run(main())",
  ].join("\n");
  try {
    const sessionDir = join(dir, "session-artifacts", RELEASE_OWNER);
    await mkdir(sessionDir, { recursive: true });
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") } });
    const receipt = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual([receipt.deliveryStatus, receipt.host, receipt.crossHost], ["queued", "us-metal02", true]);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.startsWith(`${LAUNCH} [cross-host message from release owner (${RELEASE_OWNER}) on mac;`));
    assert.ok(sent[0]!.endsWith("land 37 read-back"));
  } finally { server.close(); }
});

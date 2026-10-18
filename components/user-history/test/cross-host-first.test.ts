// Guards the 05:35Z case of 10-18: 'metal box owner', a root on the Mac, sent to 'tiktok shop', a chat that had moved to us-metal02 while its old
// file still sat in the Mac's sessions folder. The Mac daemon matched that copy and reopened it, and the copy ran tool calls until 05:39Z. A
// root's sibling send now goes by the chat catalog's host first (message-limit-check.py other_box_first).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { otherBoxRoots, type Root, type RootDirectory, sendCrossHost, siblingRow } from "../src/cross-host-message.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const OWNER = "01a11d24-ac9b-757d-ac51-9b2b7598782f";
const TIKTOK = "01a10db8-b6d5-7219-ac49-2efa75ad73d8";
const MAC_UNTITLED = "01a14d65-a8d3-75d8-91f6-ca06a694e4ac";
const ROOTS: Root[] = [
  { sessionId: OWNER, name: "metal box owner", host: "mac", status: "working" },
  { sessionId: MAC_UNTITLED, name: "Untitled", host: "mac", status: "idle" },
  { sessionId: TIKTOK, name: "tiktok shop", host: "us-metal02", status: "idle" },
  { sessionId: "01a0e0ca-ee06-776f-b18d-cbdffca4c85c", name: "Untitled", host: "us-metal02", status: "idle" },
];

test("a Mac root's send to a chat the catalog lists on the box goes to the box, even while the Mac daemon still has its old copy", async () => {
  const sent: { host: string; session: string }[] = [];
  const directory: RootDirectory = { roots: () => ROOTS, send: async session => {
    sent.push({ host: ROOTS.find(root => root.sessionId === session)!.host, session });
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
  const dir = await mkdtemp(join(tmpdir(), "cross-host-first-"));
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  // The Mac daemon as it was at 05:35Z: it lists the old tiktok shop copy and its own Untitled, and takes any send to them.
  await writeFile(join(dir, "rlm.py"), [
    "import json",
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_message.send':",
    "        open('local-sends.txt', 'a').write(payload['receiver_name'] + '\\n')",
    "        return {'deliveryStatus': 'delivered', 'local': True}",
    `    return {'agents': [{'sessionId': '${TIKTOK}', 'sessionName': 'tiktok shop', 'relationship': 'sibling'},`,
    `                       {'sessionId': '${MAC_UNTITLED}', 'sessionName': 'Untitled', 'relationship': 'sibling'}]}`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, agent_message",
    "async def main():",
    "    out = []",
    "    for to in ('tiktok shop', 'Untitled'):",
    "        out.append(await agent_message.host_request('agent_message.send', {'message': 'engage numbers?', 'receiver_role': 'sibling', 'receiver_name': to}))",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  try {
    const sessionDir = join(dir, "session-artifacts", OWNER);
    await mkdir(sessionDir, { recursive: true });
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") } });
    const [tiktok, untitled] = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual([tiktok.host, tiktok.crossHost, tiktok.local], ["us-metal02", true, undefined]);
    assert.deepEqual(sent, [{ host: "us-metal02", session: TIKTOK }]);
    assert.equal(untitled.local, true, "a name that also names a different root on the sender's box stays on that box");
    assert.equal(await readFile(join(dir, "local-sends.txt"), "utf8"), "Untitled\n");
  } finally { server.close(); }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

// 10-16 05:03 to 05:44Z the 5180 SSR hang fix job sent frontend bro one report 4 times: each agent_message.send timed out after 30 s, the job
// sent again, and every copy landed. The wrapper now remembers a send that timed out and looks for it before the same text goes again.
const TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message". Socket: /tmp/daemon.sock.';
const TARGET = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";

async function kernel(mode: "lands" | "queued" | "busy" | "lost", dataDir: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "send-once-kernel-"));
  const agentDir = dataDir ? join(dir, "agent") : null;
  const sessions = join(agentDir ?? dir, "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(dir, "rlm.py"), [
    "import json, datetime",
    "sent = []",
    `FILE = ${JSON.stringify(join(sessions, `${TARGET}.jsonl`))}`,
    `MODE = ${JSON.stringify(mode)}`,
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'agent_observe.list':",
    "        return {'current': {}, 'agents': [{'relationship': 'sibling', 'sessionName': 'frontend bro', 'sessionId': " + JSON.stringify(TARGET) + ", 'queuedCount': 1 if MODE == 'queued' else 0, 'status': 'running' if MODE == 'busy' else 'idle'}]}",
    "    sent.append(payload['message'])",
    "    if len(sent) == 1:",
    "        if MODE == 'lands':",
    "            at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')",
    "            open(FILE, 'a').write(json.dumps({'type': 'custom_message', 'customType': 'agent_message', 'details': {'id': 'agentmsg_1', 'message': payload['message']}, 'timestamp': at}) + '\\n')",
    "        raise RuntimeError(" + JSON.stringify(TIMEOUT) + ")",
    "    return {'deliveryStatus': 'delivered'}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\nasync def send(message, *, receiver_role=None, receiver_name=None):\n" +
    "    return await host_request('agent_message.send', {'message': message, 'receiver_role': receiver_role, 'receiver_name': receiver_name})\n");
  const prelude = messageCheckPrelude(agentDir ? join(agentDir, "browser-chat") : null);
  const script = prelude + [
    "import asyncio, json, os, agent_message, rlm",
    ...(agentDir ? [] : [`os.environ['HOME'] = ${JSON.stringify(dir.replace(/\/[^/]*$/, ""))}`]),
    "async def main():",
    "    out = []",
    "    for text in ['5180 SSR hang fix job: I stopped without changing any file.', '(possible duplicate) 5180 SSR hang fix job: I stopped without changing any file.']:",
    "        receipt = await agent_message.send(text, receiver_role='sibling', receiver_name='frontend bro')",
    "        out.append(receipt.get('deliveryStatus'))",
    "    out.append(len(rlm.sent))",
    "    print(json.dumps(out))",
    "asyncio.run(main())",
  ].join("\n");
  return spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, encoding: "utf8" });
}

const cases: [mode: "lands" | "queued" | "busy" | "lost", expected: unknown[], note: RegExp][] = [
  ["lands", ["unconfirmed", "delivered", 1], /not sent again\. The send of this text to frontend bro that timed out at \S+ landed at/],
  ["queued", ["unconfirmed", "unconfirmed", 1], /frontend bro has messages queued, so the daemon still holds it/],
  ["busy", ["unconfirmed", "unconfirmed", 1], /frontend bro is busy, so the daemon may still hold it/],
  ["lost", ["unconfirmed", "delivered", 2], /sends only when it is gone/],
];
for (const [mode, expected, note] of cases) {
  test(`send once in the kernel: a send that timed out and then ${mode === "lands" ? "landed" : mode === "queued" ? "sits in a busy target's queue" : mode === "busy" ? "is not found while the target runs a turn" : "is nowhere while the target is idle"} is ${mode === "lost" ? "sent again once" : "not sent again"}`, async () => {
    const run = await kernel(mode, "chat");
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.deepEqual(JSON.parse(lines.at(-1)!), expected);
    assert.match(run.stdout, note);
  });
}

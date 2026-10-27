// Guards option C of the prime-under-load page (10-27) in the kernel: the host_request wrapper (message-limit-check.py) logged no line for a
// Prime call, so "No sibling matches" and the other refusals it handles could not be counted from any log. Each call now adds one line.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

test("each kernel host_request adds one prime-calls.jsonl line with its method, target, time and outcome, and an unconfirmed receipt adds its own", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kernel-prime-calls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "rlm.py"), [
    "import asyncio",
    "async def host_request(request_type, payload=None):",
    "    if request_type == 'rlm.collect':",
    "        raise RuntimeError('Unknown active session: 0710b875bb3a')",
    "    if request_type == 'agent_message.send':",
    "        raise RuntimeError('Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\"')",
    "    if request_type == 'goal.get':",
    "        raise RuntimeError('Timed out after 30000ms waiting for the Prime Agent daemon response to \"get_goal\"')",
    "    await asyncio.sleep(0.02)",
    "    return {'children': []}",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, rlm",
    "async def main():",
    "    await rlm.host_request('rlm.list_subagents', {})",
    "    for kind, body in (('rlm.collect', {'sessionId': '0710b875bb3a'}), ('goal.get', None)):",
    "        try:",
    "            await rlm.host_request(kind, body)",
    "        except RuntimeError:",
    "            pass",
    "    receipt = await rlm.host_request('agent_message.send', {'message': 'hi', 'receiver_role': 'parent'})",
    "    assert receipt['deliveryStatus'] == 'unconfirmed', receipt",
    "asyncio.run(main())",
  ].join("\n");
  await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } });
  const lines = (await readFile(join(dir, "prime-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ src, method, target, outcome }) => ({ src, method, target, outcome })), [
    { src: "kernel", method: "rlm.list_subagents", target: undefined, outcome: "ok" },
    { src: "kernel", method: "rlm.collect", target: "0710b875bb3a", outcome: "refused" },
    { src: "kernel", method: "goal.get", target: undefined, outcome: "timeout" },
    { src: "kernel", method: "agent_message.send", target: "parent", outcome: "timeout" },
    { src: "kernel", method: "agent_message.send", target: "parent", outcome: "unconfirmed" },
  ]);
  assert.deepEqual([lines[3]!.receipt, lines[4]!.receipt, lines[4]!.state], [undefined, "unconfirmed", "timeout"], "the receipt the wrapper returned has its own line");
  assert.ok((lines[0]!.ms as number) >= 20, `${String(lines[0]!.ms)} ms`);
  assert.match(String(lines[0]!.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(lines[0]!.error, undefined);
  assert.match(String(lines[1]!.error), /Unknown active session/);
});

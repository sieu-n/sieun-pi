import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { heldStartsOf, readHeldStarts } from "../src/held-starts.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

/*
 * launch main bro 10-15 19:16Z: with the fleet budget closed at 16.3 GB, the guard from 8e4cef1 refused every kernel cell that started a root
 * job, so the check-in could give none of 18 stuck steps an owner. Crawler VP on 10-16 had 13 open steps waiting on "the Mac's fleet budget has
 * room; the check-in then starts job crawler duty fixes". A root start while the budget is closed now returns a queued handle at once, is
 * written where the check-in reads it as starting, and goes out by itself once the budget opens.
 */
const CS = "create" + "_session";
const kernel = async (closed: boolean) => {
  const dir = await mkdtemp(join(tmpdir(), "queued-root-"));
  await writeFile(join(dir, "fleet-state.json"), JSON.stringify({ at: Date.now(), closed: closed ? "the Prime workers hold 21.7 GB (budget 16 GB)" : null }));
  await writeFile(join(dir, "rlm.py"), [
    "import time",
    "sent, marks = [], []",
    "class repl:",
    "    @staticmethod",
    "    def emit(data): marks.append(list(data.values())[0]['active'])",
    "async def host_request(request_type, payload=None):",
    "    sent.append(request_type)",
    "    return {'active_session_id': 'a1', 'session_id': 's1', 'name': payload['kwargs']['name'], 'session_file': '/s/s1.jsonl', 'model': 'm'}",
    `async def ${CS}(prompt, name=None):`,
    `    return await host_request('rlm.${CS}', {'prompt': prompt, 'kwargs': {'name': name}})`,
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, os, rlm",
    "async def main():",
    `    handle = await rlm.${CS}('do it', name='crawler duty fixes')`,
    "    at_return = list(rlm.sent)",
    "    records = sorted(os.listdir(os.path.join(os.environ['DATA'], 'held-starts'))) if os.path.isdir(os.path.join(os.environ['DATA'], 'held-starts')) else []",
    "    with open(os.path.join(os.environ['DATA'], 'fleet-state.json'), 'w') as f: json.dump({'at': 0, 'closed': None}, f)",
    "    await asyncio.sleep(1.5)",
    "    held = getattr(rlm, 'held_sessions', {}).get('crawler duty fixes', {})",
    "    print(json.dumps({'handle': handle['session_id'][:7], 'at_return': len(at_return), 'later': len(rlm.sent), 'records': len([r for r in records if r.endswith('.json')]), 'held': held.get('state'), 'marks': rlm.marks}))",
    "asyncio.run(main())",
  ].join("\n");
  const run = spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir, DATA: dir, USER_HISTORY_START_POLL_S: "0.2" }, encoding: "utf8" });
  return { run, dir };
};

test("a root start while the fleet budget is closed returns a queued handle at once, waits as a held start, and goes out once the budget opens", async () => {
  const { run, dir } = await kernel(true);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { handle: "queued-", at_return: 0, later: 1, records: 1, held: "started", marks: [true, false] });
  assert.match(run.stdout, /crawler duty fixes is queued, not started: the Mac has no room for another root job now \(the Prime workers hold 21\.7 GB/);
  assert.deepEqual((await readdir(join(dir, "held-starts"))).filter(name => name.endsWith(".json")), [], "the record goes once it started");
});

test("a root start while the budget is open goes out at once", async () => {
  const { run } = await kernel(false);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { handle: "s1", at_return: 1, later: 1, records: 0, held: null, marks: [] });
});

test("the check-in reads a held start as a start of the chat the registry names, and drops one whose kernel is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "held-starts-"));
  await writeFile(join(dir, "fleet-state.json"), "{}");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "held-starts"));
  await writeFile(join(dir, "held-starts", "a.json"), JSON.stringify({ ticket: "a", name: "crawler duty fixes", parent: "check-in job", pid: process.pid, at: 2 }));
  await writeFile(join(dir, "held-starts", "b.json"), JSON.stringify({ ticket: "b", name: "gone", parent: "01a115e2", pid: 1, at: 1 }));
  await writeFile(join(dir, "held-starts", "c.json"), JSON.stringify({ ticket: "c", name: "own start", parent: "01a115e2", pid: process.pid, at: 3 }));
  await writeFile(join(dir, "held-starts", "last-start"), "x");
  const starts = await readHeldStarts(dir, pid => pid === process.pid);
  assert.deepEqual(starts.map(start => start.name), ["crawler duty fixes", "own start"]);
  const registry = { chatOf: async (name: string) => name === "crawler duty fixes" ? "01a115e2" : undefined };
  assert.deepEqual(await heldStartsOf(starts, registry, "01a115e2"), ["crawler duty fixes", "own start"]);
  assert.deepEqual(await heldStartsOf(starts, registry, "01a11bd7"), []);
});

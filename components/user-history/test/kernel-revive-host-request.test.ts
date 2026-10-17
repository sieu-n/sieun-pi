import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

// 10-16, chat 01a14210: after [python-state-restored], agent_observe.recent_messages raised "ImportError: attempted relative import with no
// known parent package" at `from . import repl` in rlm/__init__.py. Prime's snapshot pickles a skill module by value, and dill pickled the
// rlm.host_request agent_observe holds by value too, because rlm.host_request named the wrapper. The copy lost rlm's __package__.
const python = join(process.env.PRIME_AGENT_KERNEL_VENV || join(homedir(), ".prime/agent/kernel-venv"), "bin/python");
// Prime imports the skills before the first cell, so they hold rlm's own host_request when the prelude runs.
const SKILLS = "import asyncio, json, sys, rlm, rlm.repl as repl, agent_observe, agent_message\nns = {'agent_observe': agent_observe, 'agent_message': agent_message}\n";
// The wrapper before VERSION 10 ran in its own globals and replaced rlm.host_request under that module name.
const OLD_WRAPPER = `exec(${JSON.stringify([
  "import sys, rlm, agent_message",
  "async def request(request_type, payload=None):",
  "    return await sys.modules['rlm'].unchecked_host_request(request_type, payload)",
  "request.limit_checked = True",
  "rlm.unchecked_host_request = rlm.host_request",
  "rlm.host_request = agent_message.host_request = request",
  "sys.user_history_message_check = 9",
].join("\n"))}, {"__name__": "user_history_message_check"})\n`;
const RESTORE = "result = repl._restore_state(ns, snap)\n";
const CALLS = [
  "async def host(req): return {'status': 'ok', 'result': {'type': req['type']}}",
  "repl.host_request = host",
  "async def main():",
  "    out = {'failed': result['failed']}",
  "    for name in ('agent_observe', 'agent_message'):",
  "        try:",
  "            out[name] = (await ns[name].host_request('agent_observe.list_agents', {}))['type']",
  "        except Exception as error:",
  "            out[name] = f'{type(error).__name__}: {error}'",
  "    out['dataDir'] = ns['agent_message'].host_request.__globals__.get('DATA_DIR')",
  "    print(json.dumps(out))",
  "asyncio.run(main())",
].join("\n");

const run = (dir: string, script: string) => spawnSync(python, ["-c", `snap = ${JSON.stringify(join(dir, "snap.bin"))}\n${script}`], { cwd: dir, encoding: "utf8" });
const last = (out: string) => JSON.parse(out.trim().split("\n").at(-1)!);

const cases = [
  { name: "the snapshot and the revive both run the wrapper", saver: "new", order: "prelude first" },
  { name: "Prime revives before the first cell's prelude", saver: "new", order: "restore first" },
  { name: "the snapshot came from a kernel with the wrapper before VERSION 10", saver: "old", order: "restore first" },
] as const;

for (const { name, saver, order } of cases) {
  test(`a kernel revive keeps every skill's host_request working and the wrapper's data dir: ${name}`, { skip: !existsSync(python) && `no Prime kernel at ${python}` }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "revive-host-request-"));
    const wrap = saver === "new" ? messageCheckPrelude(dir) : OLD_WRAPPER;
    const saved = run(dir, SKILLS + wrap + "print(json.dumps(repl._snapshot_state(ns, snap, snap + '.json', 1 << 28, 1 << 26, False)))");
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(last(saved.stdout).saved, ["agent_message", "agent_observe"]);
    const revive = order === "prelude first" ? messageCheckPrelude(dir) + RESTORE : RESTORE + messageCheckPrelude(dir);
    const restored = run(dir, SKILLS + revive + CALLS);
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(last(restored.stdout), {
      failed: [], agent_observe: "agent_observe.list_agents", agent_message: "agent_observe.list_agents", dataDir: dir,
    });
  });
}

// 10-17: agent_message.send raised "'NoneType' object is not callable" in message-limit-check.py in 01a141b8 and a job of "grafana done
// properly", whose kernels held the wrapper while rlm no longer had unchecked_host_request. A send goes out through Prime's own host_request.
for (const lost of ["del rlm.unchecked_host_request", "import importlib; importlib.reload(rlm)", "rlm.host_request = agent_message.host_request; del rlm.unchecked_host_request"]) {
  test(`a send goes out when the wrapper's saved host_request is gone: ${lost}`, { skip: !existsSync(python) && `no Prime kernel at ${python}` }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "lost-host-request-"));
    const script = [
      "async def host(req): return {'status': 'ok', 'result': {'type': req['type'], 'message': req.get('message')}}",
      "repl.host_request = host",
      lost,
      "async def main():",
      "    reply = await agent_message.host_request('agent_message.send', {'message': 'done: 3 files', 'receiver_role': 'parent'})",
      "    print(json.dumps(reply))",
      "asyncio.run(main())",
    ].join("\n");
    const out = spawnSync(python, ["-c", SKILLS + messageCheckPrelude(dir) + script], { cwd: dir, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(last(out.stdout), { type: "agent_message.send", message: "done: 3 files" });
  });
}

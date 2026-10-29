import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The kill guard (packages/sieun-rules/src/kill.ts), board step p1273. On 10-29 at 04:24:48 KST a job on the owner's Mac ran
// `pkill -f 'svelte-check' -U $(id -u)`, which macOS pkill read as three patterns, and it closed a Prime worker's 43 sessions; at 05:44 KST
// another job ran `pkill -9 -f 'autopair-real-ig.mjs --local'`. These commands are only fed to the handlers; nothing here runs them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kill-")));
const saved = { log: process.env.GLOBAL_RULES_LOG, platform: process.env.GLOBAL_RULES_PLATFORM };
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  for (const [key, name] of [["log", "GLOBAL_RULES_LOG"], ["platform", "GLOBAL_RULES_PLATFORM"]]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });
const cell = (command) => `r = await bash(${JSON.stringify(command)})\nprint(r.output)`;

const PATTERN_KILLS = [
  "pkill -f 'svelte-check' -U $(id -u)",
  "pkill -9 -f 'scratch/01a1841b-4b7c-76ef-b100-96af03c8baed/autopair-local' ; pkill -9 -f 'autopair-real-ig.mjs --local'",
  "pkill -f 'prime-agent -p --model test-model'",
  "killall node",
  "killall -9 Chrome",
  "sudo pkill vitest",
  "pgrep -f svelte-check | xargs kill",
  "pgrep -f 'vite --port 5180' | xargs -r kill -9",
  "kill $(pgrep -f svelte-check)",
  "kill -9 `pgrep -f vitest`",
  "kill -TERM $(pidof node)",
  "ps aux | grep '[s]velte-check' | awk '{print $2}' | xargs kill -9",
  "kill $(ps -eo pid,args | grep vitest | awk '{print $1}')",
  "pids=$(pgrep -f autopair); kill $pids",
  "for p in $(pgrep -f autopair); do kill -9 $p; done",
  "pgrep -f autopair | while read p; do kill $p; done",
  "pgrep -f x | xargs pkill",
  "kill -9 -1",
  "bash -lc 'pkill -f vite'",
  "timeout 5 pkill -f vite",
  "ssh us-metal02 'pkill -f svelte-check'",
  "cd /tmp && nohup pkill -f autopair > /dev/null 2>&1 &",
];

const OWN_KILLS = [
  "kill 12345",
  "kill -9 12345",
  "kill -TERM 12345 12346",
  "kill -- -12345",
  "kill -9 -12345",
  "kill -s TERM 12345",
  "node server.mjs & pid=$!; sleep 1; kill $pid",
  "kill $(cat /tmp/server.pid)",
  "kill -0 12345 && echo alive",
  "pgrep -fl svelte-check",
  "ps aux | grep '[s]velte-check'",
  "pgrep -f vite; kill 4242",
  "rg -n 'pkill|killall' components/watchdog",
  "git commit -m 'docs: never pkill by pattern' -- README.md",
  "echo 'use kill <pid>, never pkill'",
  "systemctl --user kill my-unit",
];

function refused(toolName, texts) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /kill guard/, `${toolName}: ${text}`);
    assert.match(result.reason, /h\.kill\(\)/);
    assert.match(result.reason, /10-29/);
    assert.match(result.reason, /destructive to shared state/);
  }
}

function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

for (const platform of ["darwin", "linux"]) {
  test(`on ${platform}, a pkill, killall or a kill fed by pgrep, pidof or ps is refused in bash and in an ipython cell`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    refused("bash", PATTERN_KILLS);
    refused("ipython", PATTERN_KILLS.map(cell));
    refused("ipython", ['import subprocess\nsubprocess.run(["pkill", "-f", "svelte-check", "-U", "501"])']);
  });

  test(`on ${platform}, a kill of a pid or group the session holds passes`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    allowed("bash", OWN_KILLS);
    allowed("ipython", OWN_KILLS.map(cell));
    allowed("ipython", ["h = bash('npm run dev')\nh.kill()", "import os, signal\nos.kill(h.pid, signal.SIGTERM)"]);
  });
}

test("the kernel half refuses a pattern kill whose command the cell builds at run time", () => {
  for (const platform of ["darwin", "linux"]) {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    const result = sendCheck.judgeCheck({ kind: "shell", text: "pkill -9 -f 'autopair-real-ig.mjs --local'", cwd: root });
    assert.equal(result.block, true);
    assert.match(result.reason, /kill guard/);
    assert.deepEqual(sendCheck.judgeCheck({ kind: "shell", text: "kill -9 12345", cwd: root }), { block: false });
  }
});

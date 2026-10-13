import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { DAEMON_WORKER_START_MS, timedWorkerStart } from "../src/daemon-worker-start.ts";

/** prime-agent's own bound for one daemon request: DEFAULT_DAEMON_REQUEST_TIMEOUT_MS in dist/modes/daemon/daemon-client.js. */
async function primeAgentDefault(): Promise<number> {
  const client = new URL("../node_modules/prime-agent/dist/modes/daemon/daemon-client.js", import.meta.url);
  const match = /const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(await readFile(client, "utf8"));
  assert.ok(match, "prime-agent still names its default daemon request timeout");
  return Number(match[1]!.replaceAll("_", ""));
}

const SRC = new URL("../src/", import.meta.url);

test("daemon requests: no request in src gives up sooner than prime-agent's own 30 s default (service.log 10-12 16:05Z: 411 cron_list and 430 get_state timeouts at an unmeasured 10 s, c43)", async () => {
  const limit = await primeAgentDefault();
  assert.equal(limit, 30_000);
  const shorter: string[] = [];
  for (const name of await readdir(SRC, { recursive: true })) {
    if (!/\.(ts|mjs)$/.test(name)) continue;
    const text = await readFile(new URL(name, SRC), "utf8");
    for (const call of text.matchAll(/\.request\(\{ type: "(\w+)"[^\n]*?\}, ([\d_]+), \{/g)) {
      if (Number(call[2]!.replaceAll("_", "")) < limit) shorter.push(`${name}: ${call[1]} at ${call[2]} ms`);
    }
  }
  assert.deepEqual(shorter, [], "pass undefined to use prime-agent's default, or cite the measurement that backs a shorter bound");
});

test("daemon requests: every create and reload waits DAEMON_WORKER_START_MS, which sits above the longest create the daemon finished (1,388 s, 10-12 10:30Z)", async () => {
  assert.ok(DAEMON_WORKER_START_MS > 1_388_000);
  const starts: string[] = [];
  for (const name of await readdir(SRC, { recursive: true })) {
    if (!/\.(ts|mjs)$/.test(name)) continue;
    const text = await readFile(new URL(name, SRC), "utf8");
    for (const call of text.matchAll(/request\(\{ type: "(create|reload)"[\s\S]*?\}, ([\w.?_ ]+), \{ recoverable/g)) starts.push(`${name}: ${call[1]} ${call[2]}`);
  }
  assert.deepEqual(starts.map(start => start.replace(/^.*: \w+ /, "")), starts.map(() => "DAEMON_WORKER_START_MS"), starts.join("; "));
  assert.equal(starts.length, 3, "the thread create, the resume create and the extension reload");
});

test("daemon requests: a create or reload writes its duration to service.log, answered, refused or with no answer", async () => {
  const lines: string[] = [];
  let clock = Date.parse("2026-10-13T01:00:00Z");
  const log = (line: string) => { lines.push(line); };
  const now = () => clock;
  assert.deepEqual(await timedWorkerStart("create probe", async () => { clock += 7_044; return { success: true }; }, log, now), { success: true });
  await timedWorkerStart("reload 01a132ba", async () => { clock += 1_100; return { success: false, error: "Session worker is stopping" }; }, log, now);
  await assert.rejects(timedWorkerStart("resume 01a12f4c", async () => { clock += 60_000; throw new Error("Timed out"); }, log, now), /Timed out/);
  assert.deepEqual(lines, [
    "2026-10-13T01:00:00.000Z daemon create probe: answered in 7.0 s",
    "2026-10-13T01:00:07.044Z daemon reload 01a132ba: refused in 1.1 s",
    "2026-10-13T01:00:08.144Z daemon resume 01a12f4c: no answer after 60.0 s: Timed out",
  ]);
});

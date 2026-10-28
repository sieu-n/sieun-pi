// 10-27 to 10-28: 31 subagents of sep launch!! and frontend bro on the Mac were woken 311 times in 12 h by their own time wakes, each of which
// only looked whether a promote, a sha or a unit had moved and set the next one ("if done ..., else rewake"), and the idle unload stopped them
// 167 times between them. A check wake runs that look in the chat service and wakes the session only once it passes or its deadline comes.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { KINDS, parseWake, POLL_HINT, pendingWakes, runCheck, startWakes, wakeLabel, Wakes, wakeText } from "../src/wakes.ts";

const START = Date.parse("2026-10-28T03:00:00Z");
const MIN = 60_000;
const session = "01a17e63-0f59-724d-9c1a-fc0e584a5489";
const check = { kind: "check", command: "curl -s https://virev.ai/_app/version.json | grep -q 0bfedc2", every: 5 * MIN, at: START + 60 * MIN };

test("a check wake runs its command at its pace, holds the session until it exits 0, and wakes it once with the output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wake-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, `${session}-check-1.json`), JSON.stringify({ session, root: "01a15427-145f-751d-ba15-d27b6c30f65f", on: check, note: "p127", since: START }));
  let now = START;
  const runs: number[] = [];
  let passes = false;
  const sent: { session: string; text: string }[] = [];
  const wakes = new Wakes({ dir, now: () => now, runState: async () => ({ done: false }), log: () => {},
    check: async (command, timeoutMs) => { assert.equal(command, check.command); assert.equal(timeoutMs, check.every); runs.push(now); return passes ? { ok: true, output: "0bfedc2\n" } : { ok: false, output: "" }; },
    deliver: async (to, text) => { sent.push({ session: to, text }); } });
  for (; now < START + 12 * MIN; now += 30_000) assert.equal(await wakes.tick(), 0);
  assert.deepEqual(runs, [START, START + 5 * MIN, START + 10 * MIN]);
  assert.equal((await pendingWakes(dir, now)).length, 1);
  assert.equal(wakeLabel(await pendingWakes(dir, now)), "a board.wake on a check by 04:00Z");
  passes = true;
  for (; now < START + 16 * MIN; now += 30_000) await wakes.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.session, session);
  assert.match(sent[0]!.text, /^\[wake\] Your board\.wake check passed at 2026-10-28T03:15:00\.000Z: `curl .* exited 0\. It printed: 0bfedc2 Your note: p127$/);
  assert.deepEqual(await readdir(dir), []);
});

test("a check that never passes wakes the session at its deadline with its last output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wake-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, `${session}-check-1.json`), JSON.stringify({ session, on: { ...check, at: START + 7 * MIN }, note: "", since: START }));
  let now = START;
  const sent: string[] = [];
  const wakes = new Wakes({ dir, now: () => now, runState: async () => ({ done: false }), log: () => {}, check: async () => ({ ok: false, output: "416fae9" }),
    deliver: async (_to, text) => { sent.push(text); } });
  for (; now < START + 7 * MIN; now += 30_000) await wakes.tick();
  assert.deepEqual(sent, []);
  await wakes.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /the deadline you set with board\.wake \(2026-10-28T03:07:00\.000Z\), and your check `curl .*` never exited 0\. Its last run printed: 416fae9$/);
});

test("a time wake tells a polling job about check wakes, and a check runs in sh with its exit status", async () => {
  const time = parseWake({ session, on: { kind: "time", at: START }, note: "", since: START })!;
  assert.ok(wakeText(time, null, START).endsWith(POLL_HINT));
  assert.equal(parseWake({ session, on: { ...check, every: 0 }, note: "", since: START }), null);
  assert.deepEqual(await runCheck("echo ok; exit 0", 10_000), { ok: true, output: "ok\n" });
  assert.equal((await runCheck("echo no; exit 3", 10_000)).ok, false);
});

test("a running service names check among the wake kinds it delivers, which board.wake reads before it writes a check wake", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wake-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stop = startWakes({ dir, runState: async () => ({ done: false }), deliver: async () => {}, log: () => {} }, 60_000);
  t.after(stop);
  for (let i = 0; i < 50 && !(await readdir(dir)).includes(KINDS); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual((await readFile(join(dir, KINDS), "utf8")).split(/\s+/).filter(Boolean), ["run", "time", "check"]);
});

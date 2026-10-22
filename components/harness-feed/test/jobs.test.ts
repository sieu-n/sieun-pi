import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promName, type Context, type Sample } from "../otlp.ts";
import { admitTime, causeReason, Counts, heldReason, idTime, read, stoppedReason } from "../readers/jobs.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "jobs");
const ids = JSON.parse(readFileSync(join(FIXTURES, "ids.json"), "utf8")) as { NOW: number; A: string; B: string; J: Record<string, string>; R1: string; R2: string };
const later = JSON.parse(readFileSync(join(FIXTURES, "round2.json"), "utf8")) as { service: string[]; ledger: string[]; pool: string[]; cancel: Record<string, unknown> };
const { NOW, J } = ids;
const HOUR = 3_600_000;

const value = (samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(s => s.name === name && JSON.stringify(Object.entries(s.labels ?? {}).sort()) === JSON.stringify(Object.entries(labels).sort()))?.value;
const series = (samples: Sample[], name: string): Sample[] => samples.filter(s => s.name === name);

/** A fresh copy of the fixture home, since the rounds append to its logs. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-jobs-"));
  cpSync(join(FIXTURES, "home"), dir, { recursive: true });
  return dir;
}
const context = (dir: string, now: number, chatHost = true, state = new Map<string, unknown>()): Context =>
  ({ home: dir, host: "us-metal02", platform: "linux", now, chatHost, state });

function appendRound2(dir: string): void {
  appendFileSync(join(dir, ".prime/agent/browser-chat/service.log"), later.service.join("\n") + "\n");
  appendFileSync(join(dir, ".prime/agent/rlm-ledger/0123456789abcdef.jsonl"), later.ledger.join("\n") + "\n");
  appendFileSync(join(dir, ".config/pi-pool/pi-pool.log"), later.pool.join("\n") + "\n");
  const cancels = join(dir, ".prime/agent/browser-chat/job-cancels.json");
  writeFileSync(cancels, JSON.stringify({ ...JSON.parse(readFileSync(cancels, "utf8")), ...later.cancel }));
}

test("the first round counts jobs working and queued per chat, leaving the chats' own turns out", async () => {
  const samples = await read(context(home(), NOW));
  assert.equal(value(samples, "harness.jobs.running", { chat: "alpha chat" }), 1);
  assert.equal(value(samples, "harness.jobs.running", { chat: "beta chat" }), 1, "a root job named in chat-jobs.json counts under its chat");
  assert.equal(value(samples, "harness.jobs.queued", { chat: "alpha chat" }), 1);
  assert.equal(value(samples, "harness.jobs.queued", { chat: "beta chat" }), 0, "a chat's own queued turn is no job");
  assert.equal(value(samples, "harness.jobs.queued_oldest", { chat: "alpha chat" }), 1800);
});

test("the first-turn wait runs from the spawn record to the first pi-pool admission, with KST and UTC log times", async () => {
  const samples = await read(context(home(), NOW));
  assert.equal(value(samples, "harness.jobs.first_turn_count", { window: "30m" }), 3);
  assert.equal(value(samples, "harness.jobs.first_turn_wait", { q: "p50", window: "30m" }), 62, "the root job waits from its session's creation");
  assert.equal(value(samples, "harness.jobs.first_turn_wait", { q: "p90", window: "30m" }), 300, "a KST log time reads 9 h back");
  assert.equal(value(samples, "harness.jobs.first_turn_wait", { q: "max", window: "30m" }), 300);
  assert.equal(value(samples, "harness.jobs.first_turn_waiting"), 1, "a job deleted before its first turn waits no more");
  assert.equal(value(samples, "harness.jobs.first_turn_waiting_oldest"), 2400);
  assert.deepEqual(series(samples, "harness.jobs.first_turn_waiting_top").map(s => s.labels),
    [{ rank: "1", name: "j three", session: J["3"], chat: "alpha chat" }]);
});

test("an empty window sends only its count, so the panel reads no data instead of 0 s", async () => {
  const samples = await read(context(home(), NOW + 2 * HOUR));
  assert.equal(value(samples, "harness.jobs.first_turn_count", { window: "30m" }), 0);
  assert.equal(series(samples, "harness.jobs.first_turn_wait").length, 0);
});

test("parked jobs are the last pass's pool-held sessions, by the reason their held line gave", async () => {
  const dir = home();
  const state = new Map<string, unknown>();
  let samples = await read(context(dir, NOW, true, state));
  assert.equal(value(samples, "harness.jobs.parked", { chat: "alpha chat", reason: "account limit" }), 1);
  assert.equal(value(samples, "harness.jobs.parked", { chat: "beta chat", reason: "unknown" }), 1);
  assert.equal(value(samples, "harness.jobs.parked_longest", { reason: "account limit" }), 600);
  appendRound2(dir);
  samples = await read(context(dir, NOW + 30_000, true, state));
  assert.equal(value(samples, "harness.jobs.parked", { chat: "beta chat", reason: "no token" }), 1);
  assert.equal(value(samples, "harness.jobs.parked", { chat: "beta chat", reason: "unknown" }), 0, "a reason that left goes to 0 instead of holding");
});

test("event counters start at 0, count only lines added after the first read, and count each cut and skip once", async () => {
  const dir = home();
  const state = new Map<string, unknown>();
  const first = await read(context(dir, NOW, true, state));
  for (const name of ["harness.jobs.cut", "harness.jobs.resumed", "harness.jobs.not_resumed", "harness.jobs.spawned", "harness.jobs.deleted"])
    assert.equal(series(first, name).length, 0, `${name} counts nothing from the first read`);
  appendRound2(dir);
  const second = await read(context(dir, NOW + 30_000, true, state));
  assert.ok(series(second, "harness.jobs.cut").length > 0);
  assert.ok(series(second, "harness.jobs.cut").every(s => s.value === 0), "a new label set goes out at 0 first");
  const third = await read(context(dir, NOW + 60_000, true, state));
  const cut = (chat: string, reason: string) => value(third, "harness.jobs.cut", { chat, reason });
  assert.equal(cut("beta chat", "no token"), 1);
  assert.equal(cut("beta chat", "rate limit"), 1);
  assert.equal(cut("alpha chat", "owner stop"), 1);
  assert.equal(cut("alpha chat", "lease ran out"), 1);
  assert.equal(cut("alpha chat", "account limit"), undefined, "a held line the pass repeats is no new cut");
  assert.equal(cut("alpha chat", "error"), undefined, "the continue of a cut already seen is no new cut");
  assert.equal(series(third, "harness.jobs.cut").length, 4);
  assert.equal(value(third, "harness.jobs.resumed", { chat: "alpha chat", how: "resume pass", result: "delivered" }), 1);
  assert.equal(value(third, "harness.jobs.resumed", { chat: "alpha chat", how: "check-in", result: "restarted" }), 1);
  assert.equal(value(third, "harness.jobs.not_resumed", { chat: "beta chat", reason: "not owed" }), 1);
  assert.equal(value(third, "harness.jobs.not_resumed", { chat: "beta chat", reason: "unresolved" }), 1);
  assert.equal(series(third, "harness.jobs.not_resumed").length, 2, "a stopped job the pass names again is skipped once");
  assert.equal(value(third, "harness.jobs.spawned", { chat: "alpha chat", kind: "subagent" }), 1);
  assert.equal(value(third, "harness.jobs.deleted", { chat: "alpha chat", reason: "user" }), 1);
  assert.equal(value(third, "harness.jobs.first_turn_count", { window: "30m" }), 4);
  assert.equal(promName(series(third, "harness.jobs.cut")[0]!), "harness_jobs_cut_total");
});

test("a box with no chat service sends the pool and ledger numbers under unknown chat", async () => {
  const samples = await read(context(home(), NOW, false));
  assert.equal(value(samples, "harness.jobs.queued", { chat: "unknown chat" }), 1);
  assert.equal(value(samples, "harness.jobs.first_turn_count", { window: "30m" }), 2, "root jobs come from chat-jobs.json, which only the chat host reads");
  assert.equal(series(samples, "harness.jobs.parked").length, 0);
});

test("reasons come from the words the resume pass writes", () => {
  assert.equal(heldReason("pi-pool holds the tree until 2026-10-22T09:20:05+00:00"), "account limit");
  assert.equal(heldReason("claude-virev5@slack.green is limited 1m"), "account limit");
  assert.equal(heldReason("the token hook gave no anthropic token (exit 1)"), "no token");
  assert.equal(heldReason("pi-pool gave this session a slot at 2026-10-22T07:10:00+00:00"), "slot wait");
  assert.equal(heldReason("queued in pi-pool for a working slot, place 3 of 180"), "turn queue");
  assert.equal(heldReason("no anthropic account can serve"), "no account");
  assert.equal(causeReason("rate limit 429, claude3 limited until 09:20 at 2026-10-22T07:06:50.767Z"), "rate limit");
  assert.equal(causeReason("no account token from pi-pool at 2026-10-22T07:06:50.767Z"), "no token");
  assert.equal(causeReason("cut_off at 2026-10-22T07:06:50.767Z"), "cut off");
  assert.equal(stoppedReason("its parent deleted it (rlm ledger delete, reason user, at 2026-10-22T06:54:37.747Z)"), "parent deleted");
  assert.equal(stoppedReason("the owner archived its chat after its last message (archived-chats.json), so the sweep does not restart it"), "chat archived");
  assert.equal(stoppedReason("archived by the owner"), "owner archived");
  assert.equal(stoppedReason("a job above it was deleted (sub-1234abcd, rlm ledger delete, reason user)"), "ancestor deleted");
});

test("a pi-pool time reads as UTC or KST, whichever falls after the spawn", () => {
  const spawn = Date.parse("2026-10-22T07:00:00Z");
  assert.equal(admitTime(Date.parse("2026-10-22T07:05:00Z"), spawn, spawn + HOUR), Date.parse("2026-10-22T07:05:00Z"));
  assert.equal(admitTime(Date.parse("2026-10-22T16:05:00Z"), spawn, spawn + HOUR), Date.parse("2026-10-22T07:05:00Z"));
  assert.equal(admitTime(Date.parse("2026-10-22T05:00:00Z"), spawn, spawn + HOUR), null);
  assert.equal(idTime("01a1628f-3210-75bb-bbdc-3e1df405ff72"), 0x01a1628f3210);
});

test("a counter label set goes out at 0 once, then with its count", () => {
  const counts = new Counts();
  counts.add({ reason: "x" });
  assert.deepEqual(counts.samples({ name: "c", kind: "counter", help: "" }).map(s => s.value), [0]);
  counts.add({ reason: "x" });
  assert.deepEqual(counts.samples({ name: "c", kind: "counter", help: "" }).map(s => s.value), [2]);
});

// Guards d7's queue_holds_30 on 10-18. From 09:05Z to 10:43Z 13 jobs waited on pi-pool slots after a 429, token stampede backoff (01a14e26) among
// them, and each 15 min of Prime's retry read as an 11 to 15 min cut hold, though each job started within a minute of its slot and a continue
// before it met the same refusal. A cut that was not held got its continue only at the next 10 min job sweep.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CutJob, measure, poolHeldCuts } from "../scripts/duties/whole-system.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { CHECK_IN_TICK_MS, Chats, SUPERVISOR_RESUME_MS } from "../src/chats.ts";
import { type Cut, cutSpans, resumesNow, SessionCuts } from "../src/cut-end.ts";
import { IdIndex } from "../src/id-index.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import type { SessionRow } from "../src/shared/types.ts";
import { turnErrorCause } from "../src/turn-error.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const at = (clock: string) => Date.parse(`2026-10-18T${clock}Z`);
const LIMIT = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";
const slotError = (slot: string) => `${LIMIT} pi-pool: pool-account-5 is limited until 2026-10-18T10:50:00.000Z; this session waits for its slot at 2026-10-18T${slot}Z. Try again in 15 minutes.`;
const line = (entry: object) => JSON.stringify(entry);
// token stampede backoff's transcript from 09:20Z to 09:50Z, cut down to the fields cutSpans reads.
const STAMPEDE = [
  line({ type: "custom_message", customType: "agent_message", timestamp: "2026-10-18T08:34:00.000Z", content: "[agent-message from parent]" }),
  line({ type: "message", timestamp: "2026-10-18T09:20:55.643Z", message: { role: "assistant", stopReason: "error", errorMessage: slotError("10:42:00.000") } }),
  line({ type: "message", timestamp: "2026-10-18T09:35:52.337Z", message: { role: "user", content: "The check-in restarted you" } }),
  line({ type: "message", timestamp: "2026-10-18T09:35:53.224Z", message: { role: "assistant", stopReason: "error", errorMessage: slotError("10:42:00.000") } }),
];
const clean = (now: number): WatchLine[] => Array.from({ length: 30 }, (_, minute) => ({
  at: new Date(Math.floor(now / 60_000) * 60_000 - (30 - minute) * 60_000 + 30_000).toISOString(),
  usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 }));
const job = (span: Cut & { resumedAt?: number }): CutJob => ({ session: "01a14e26-06ee-705a-96c6-0ab6c16810eb", name: "token stampede backoff",
  chat: "01a1164b-4a2d-742d-b27a-82f086ed0200", ...span });
const run = (clock: string, cut: CutJob[]) => measure({ now: at(clock), watch: clean(at(clock)), log: { holds: [] }, chats: [], cut });

test("a provider error pi-pool holds until its slot carries the slot, and its wait before the slot is no hold", () => {
  const spans = cutSpans(STAMPEDE);
  assert.deepEqual(spans.map(span => [span.at, span.slotAt, span.resumedAt]),
    [[at("09:20:55.643"), at("10:42:00"), at("09:35:52.337")], [at("09:35:53.224"), at("10:42:00"), undefined]]);
  const { metrics } = run("09:50:00", spans.map(job));
  assert.equal(metrics.queue_holds_30, 0, "09:20Z to 09:35Z waited on the 10:42Z slot");
  assert.equal(metrics.cut_jobs_held, 0, "the live cut waits on its slot too");
});

test("a cut job whose continue pi-pool holds until its tree serves again waits on the pool, and its minutes stay clean (dead-ts, 10-20 00:44Z)", () => {
  const dead = { at: at("09:31:07"), cause: "error" as const };
  const held = measure({ now: at("10:44:00"), watch: clean(at("10:44:00")), log: { holds: [] }, chats: [], cut: [job(dead)], poolHeldJobs: new Set([job(dead).session]) });
  assert.equal(held.metrics.clean_min_30, 30);
  assert.equal(held.metrics.held_min_30, 0);
  assert.equal(held.metrics.cut_jobs_held, 0);
  assert.equal(held.metrics.cell_holds_30, 1);
  assert.equal(held.metrics.cell_wait_min_30, 30);
  assert.match(held.flagged?.find(slice => slice.kind === "queue_hold")?.excerpt ?? "", /waited from 09:31Z for pi-pool to admit its tree again/);
  const resumed = measure({ now: at("10:46:00"), watch: clean(at("10:46:00")), log: { holds: [] }, chats: [], cut: [job({ ...dead, resumedAt: at("10:45:00") })],
    poolHeldJobs: new Set([job(dead).session]) });
  assert.equal(resumed.metrics.clean_min_30, 30, "its minutes stay clean after its continue went through");
  assert.deepEqual([...poolHeldCuts([
    "job dead-ts: held by pi-pool until 2026-10-20T01:16:08+00:00: pi-pool holds the tree until 2026-10-20T01:16:08+00:00 (cut at 2026-10-19T23:31:07.493Z, tree 01a1180e, 01a15662-531d-765d-bd30-f4243a25ddb5)",
    "job dead-py: interrupted (error at ?); continue: sent"])], ["01a15662-531d-765d-bd30-f4243a25ddb5"]);
  const free = run("10:44:00", [job(dead)]);
  assert.equal(free.metrics.clean_min_30, 0, "a cut the pool does not hold is still a hold nobody moves");
  assert.equal(free.metrics.cut_jobs_held, 1);
});

test("a cut still not started 10 min after its slot is a hold from the slot on", () => {
  const live = { at: at("09:35:53.224"), cause: "error" as const, slotAt: at("10:42:00") };
  assert.equal(run("10:51:00", [job(live)]).metrics.cut_jobs_held, 0);
  const late = run("10:53:00", [job(live)]);
  assert.equal(late.metrics.cut_jobs_held, 1);
  assert.match(late.flagged?.find(slice => slice.kind === "queue_hold")?.excerpt ?? "", /waited 11 min, 10:42Z to 10:53Z/);
  assert.equal(run("09:50:00", [job({ at: at("09:35:53.224"), cause: "error", resumedAt: at("09:47:00") })]).metrics.queue_holds_30, 1,
    "a cut with no slot holds from the cut");
});

test("each cut a read finds new goes to the listener once, and only a cut nobody else starts resumes now", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-resume-"));
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "job.jsonl");
    await writeFile(file, STAMPEDE.slice(0, 1).concat(line({ type: "message", timestamp: "2026-10-18T10:26:47.724Z",
      message: { role: "assistant", stopReason: "error", errorMessage: LIMIT } })).join("\n") + "\n");
    const seen: Cut[] = [];
    const cuts = new SessionCuts(cut => seen.push(cut));
    await cuts.update([{ file, key: "a" }]);
    await cuts.update([{ file, key: "a" }]);
    assert.deepEqual(seen, [{ at: at("10:26:47.724"), cause: "error", error: turnErrorCause(LIMIT) }]);
    assert.equal(resumesNow(seen[0]!, at("10:27:00")), true);
    assert.equal(resumesNow({ at: at("10:26:47"), cause: "error", slotAt: at("10:43:00") }, at("10:27:00")), false, "Prime's retry starts it at its slot");
    assert.equal(resumesNow({ at: at("10:26:47"), cause: "error", slotAt: at("10:43:00") }, at("10:44:00")), true);
    assert.equal(resumesNow({ at: at("10:26:47"), cause: "archived", archivedAt: at("10:26:47") }, at("10:27:00")), false, "the sweep reads an archive's cause first");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a cut seen brings the pass over interrupted jobs to the next tick, and a later supervisor change does not push it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-resume-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    let now = at("10:20:00");
    const rows = (): SessionRow[] => [row("c1", "2026-10-18T10:20:00Z", { chat: true, agents: [] })];
    let passes = 0;
    let release: () => void = () => {};
    let hold = false;
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, {}, () => now, rows), interrupted: async () => { passes++; if (hold) await new Promise<void>(done => { release = done; }); return null; } }, () => {});
    await chats.adopt();
    const step = async (ms: number) => { now += ms; await chats.tick(); };
    await step(0);
    await chats.settled();
    assert.equal(passes, 1);
    now += CHECK_IN_TICK_MS;
    chats.interruptedSoon(0);
    chats.interruptedSoon(SUPERVISOR_RESUME_MS);
    await step(0);
    await chats.settled();
    assert.equal(passes, 2, "the pass runs at the tick after the cut, not at the next 10 min sweep");
    hold = true;
    chats.interruptedSoon(0);
    await step(CHECK_IN_TICK_MS);
    for (let tick = 0; tick < 3; tick++) { chats.interruptedSoon(0); await step(CHECK_IN_TICK_MS); }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(passes, 3, "the pass that runs holds the lane");
    hold = false;
    release();
    await chats.settled();
    assert.equal(passes, 4, "the cuts seen while it ran wait as one more pass, not one per tick");
    chats.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

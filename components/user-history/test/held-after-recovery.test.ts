// Guards d7's held minutes after a job recovers. Census writer speed (01a14d5d) was stopped mid-tool at 06:46:13.981Z on 10-18, d7 at 07:05Z
// marked 06:56Z to 07:04Z dirty, and Crawler VP's message resumed it at 07:15:10.102Z. The 07:25Z and 07:30Z runs then read held_min_30 0 and
// clean_min_30 30, because the job no longer ended cut and the hold came only from its live state.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cutJobsHoldingWork, type CutJob, findCutJobs, measure } from "../scripts/duties/whole-system.ts";
import { cutEnd, cutSpans } from "../src/cut-end.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const SESSION = "01a14d5d-b858-751f-81d4-4dde95370f8c";
const at = (clock: string) => Date.parse(`2026-10-18T${clock}Z`);

// The job's transcript around the cut, its lines cut down to the fields cutEnd reads.
const TRANSCRIPT = [
  { type: "custom_message", customType: "agent_message", timestamp: "2026-10-18T05:45:46.584Z", content: "[agent-message from parent:Crawler VP]" },
  { type: "message", timestamp: "2026-10-18T06:45:50.000Z", message: { role: "assistant", stopReason: "toolUse" } },
  { type: "custom_message", customType: "prime-agent.update_restart", timestamp: "2026-10-18T06:46:02.957Z", content: "<prime_agent_update_interrupted>" },
  { type: "message", timestamp: "2026-10-18T06:46:13.981Z", message: { role: "toolResult", content: [{ type: "text", text: "Request was aborted" }] } },
  { type: "git_state", timestamp: "2026-10-18T06:46:13.989Z" },
  { type: "custom_message", customType: "harness_digest", timestamp: "2026-10-18T07:15:09.206Z", content: "" },
  { type: "custom_message", customType: "agent_message", timestamp: "2026-10-18T07:15:10.102Z", content: "[agent-message from parent:Crawler VP] From Crawler ops: a daemon update cut you at 06:46Z. Resume." },
  { type: "message", timestamp: "2026-10-18T07:15:20.078Z", message: { role: "assistant", stopReason: "toolUse" } },
  { type: "message", timestamp: "2026-10-18T07:15:21.771Z", message: { role: "toolResult", content: [{ type: "text", text: "07:15:20" }] } },
  { type: "message", timestamp: "2026-10-18T07:15:49.733Z", message: { role: "assistant", stopReason: "stop" } },
  { type: "session_state", timestamp: "2026-10-18T07:18:23.134Z", state: { status: "archived" } },
].map(entry => JSON.stringify(entry));

const resumed: CutJob = { session: SESSION, name: "census writer speed", chat: CHAT, at: at("06:46:13.981"), cause: "mid-tool", resumedAt: at("07:15:10.102") };
const clean = (now: number): WatchLine[] => Array.from({ length: 30 }, (_, minute) => ({
  at: new Date(Math.floor(now / 60_000) * 60_000 - (30 - minute) * 60_000 + 30_000).toISOString(),
  usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 }));
const run = (clock: string, cut: CutJob) => measure({ now: at(clock), watch: clean(at(clock)), log: { holds: [] }, chats: [], cut: [cut] });

test("the transcript keeps the 06:46Z cut and the 07:15Z message that ended it, though it no longer ends cut", () => {
  assert.equal(cutEnd(TRANSCRIPT), null);
  assert.deepEqual(cutSpans(TRANSCRIPT), [{ at: at("06:46:13.981"), cause: "mid-tool", resumedAt: at("07:15:10.102") }]);
  assert.deepEqual(cutSpans(TRANSCRIPT.slice(0, 5)), [{ at: at("06:46:13.981"), cause: "mid-tool" }], "before 07:15Z the cut is the live one");
});

test("findCutJobs at 07:25:25Z finds the resumed cut, and no open step is needed for it to count", async () => {
  const root = await mkdtemp(join(tmpdir(), "held-after-recovery-"));
  try {
    const dir = join(root, "session-artifacts", CHAT, "sub-aafb40c0");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${SESSION}.jsonl`);
    await writeFile(file, TRANSCRIPT.join("\n") + "\n");
    await writeFile(join(dir, "rlm-subagent.json"), JSON.stringify({ sessionName: "census writer speed" }));
    await utimes(file, at("07:18:23.134") / 1000, at("07:18:23.134") / 1000);
    const found = await findCutJobs(join(root, "session-artifacts"), [CHAT], {}, at("07:25:25"));
    assert.deepEqual(found.map(job => ({ name: job.name, at: job.at, resumedAt: job.resumedAt })),
      [{ name: "census writer speed", at: at("06:46:13.981"), resumedAt: at("07:15:10.102") }]);
    assert.equal(cutJobsHoldingWork(found, new Map([[CHAT, null]])).length, 1);
    assert.equal(cutJobsHoldingWork(found, new Map([[CHAT, null]]), new Set([CHAT])).length, 0, "a paused chat's cut is still the owner's to hold");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("each minute from 06:56Z to 07:15Z stays held after the job recovered, in every later window that covers it", () => {
  const { resumedAt: _, ...live07 } = resumed;
  const live = run("07:05:13", live07);
  assert.equal(live.metrics.held_min_30, 9, "07:05Z: 06:56Z to 07:04Z, as the run then read");
  assert.equal(live.metrics.cut_jobs_held, 1);
  for (const [clock, held] of [["07:25:25", 20], ["07:30:40", 16], ["07:38:05", 8]] as const) {
    const { metrics, flagged } = run(clock, resumed);
    assert.equal(metrics.held_min_30, held, clock);
    assert.equal(metrics.clean_min_30, 30 - held, clock);
    assert.equal(metrics.queue_holds_30, 1, clock);
    assert.equal(metrics.cut_jobs_held, 0, `${clock}: a resumed job is no live cut`);
    assert.match(flagged?.find(slice => slice.kind === "queue_hold")?.excerpt ?? "", /census writer speed .* waited 29 min, 06:46Z to 07:15Z/);
  }
  assert.equal(run("07:47:00", resumed).metrics.held_min_30, 0, "a window that starts after 07:15Z holds none of it");
});

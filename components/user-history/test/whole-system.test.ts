import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { cutJobsHoldingWork, findCutJobs, interruptionProof, measure, readDaemonStops, readLimits, readServiceLog, type CutJob, type Inputs } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { cutEnd } from "../src/cut-end.ts";

// Shapes from service.log and pi-pool.log on 10-15 and 10-16: wakes held by the fleet budget each tick.
const NOW = Date.parse("2026-10-15T21:40:00.000Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const line = (minutesAgo: number, fields: Partial<WatchLine> = {}): WatchLine => ({ at: at(minutesAgo), usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 },
  workers: 10, workerGb: 8, top: [], live: 20, working: 8, idle15: 0, idleOver: 0, idleTrees: [], finished: 0, finishedTrees: [],
  queue: { working: 8, queued: 0, oldestWaitS: 0, oldestTree: null }, mac: { swapGb: 4, pressureLevel: 1 }, cpuMs: 50, ...fields }) as WatchLine;
const inputs = (fields: Partial<Inputs>): Inputs => ({ now: NOW, watch: [], log: { holds: [] }, limits: [], okLimit: 15, chats: [], ...fields });

test("held wakes join into one hold per wake", () => {
  const facts = readServiceLog([
    `${at(40)} wakes: wake 01a10db8 for its time: held by the fleet budget: 49 starts wait for the fleet budget; tried again next tick`,
    `${at(20)} wakes: wake 01a10db8 for its time: held by the fleet budget: 50 starts wait for the fleet budget; tried again next tick`,
    ...[16, 12, 8, 4].map(ago => `${at(ago)} wakes: wake 01a10db8 for its time: held by the fleet budget: 50 starts wait for the fleet budget; tried again next tick`),
    `${at(2)} wakes: wake 01a10db8 for its time, its time: held by the fleet budget: the Prime workers hold 17.6 GB (budget 16 GB); tried again next tick`,
    `${at(3)} fleet budget: duty skills and tools AI harness developer environment 04:30 starts after 900 s`,
  ]);
  // The 20-minute gap after the first line breaks the hold, so the wake counts from 20 minutes ago.
  assert.deepEqual(facts.holds.map(hold => [hold.what, (NOW - hold.from) / 60_000, (NOW - hold.to) / 60_000]),
    [["wake of 01a10db8", 40, 40], ["wake of 01a10db8", 20, 2], ["duty skills and tools AI harness developer environment 04:30", 18, 3]]);
});

test("a minute is clean only with the Mac usable, no hold over 10 minutes and no turn queued with free slots", () => {
  const watch = Array.from({ length: 30 }, (_, index) => line(29 - index));
  // Minute 5 ago: kernel_task over a core. Minute 3 ago: 4 turns waited 3 min with 7 of 15 slots used. Minute 1 ago: no watch line.
  watch[24] = line(5, { usable: { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 140 } });
  watch[26] = line(3, { queue: { working: 7, queued: 4, oldestWaitS: 180, oldestTree: "slack green guy" } });
  watch.splice(28, 1);
  const quiet = measure(inputs({ watch }));
  assert.equal(quiet.metrics.clean_min_30, 27);
  assert.equal(quiet.metrics.usable_min_30, 28);
  assert.equal(quiet.metrics.queued_free_slot_min_30, 1);
  // Under the critical limit of 7 the same queue is no fault.
  assert.equal(measure(inputs({ watch, limits: readLimits([JSON.stringify({ ts: "2026-10-16T06:00:00", event: "pressure_level", at: (NOW - 60 * 60_000) / 1000, limit_to: 7 })]) })).metrics.queued_free_slot_min_30, 0);
});

test("stuck steps add up each chat's newest measured check-in", () => {
  const run = (duty: string, minutesAgo: number, verdict: "met" | "missed" | "skipped", stuck: number) => ({ duty, at: NOW - minutesAgo * 60_000, slot: 0, trigger: "schedule", ms: 1, verdict,
    metrics: { stuck_steps: { value: stuck, target: 0, op: "<=", met: stuck === 0 } }, summary: "" }) as unknown as Inputs["chats"][number]["runs"][number];
  const output = measure(inputs({ chats: [
    { id: "a", name: "ops guy", duties: [{ id: "checkin", name: "Check-in" }], runs: [run("checkin", 5, "skipped", 0), run("checkin", 60, "missed", 3)] },
    { id: "b", name: "Crawler VP", duties: [{ id: "checkin", name: "Check-in" }], runs: [run("checkin", 10, "met", 0), run("checkin", 70, "missed", 5)] },
  ] }));
  assert.equal(output.metrics.stuck_steps_all, 3);
});

test("whole-system.duty.json: a duty every 30 minutes on the owner's words, whose metrics the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/whole-system.duty.json"), "utf8")), "d7", 0);
  assert.deepEqual(duty.schedule, { kind: "every", minutes: 30 });
  assert.match(duty.ownerWords, /reorganize duties have a 30 minute trigger that checks all this$/);
  assert.equal(duty.metrics.find(metric => metric.headline)?.key, "clean_min_30");
  const written = Object.keys(measure(inputs({})).metrics);
  for (const metric of duty.metrics) assert.ok(written.includes(metric.key), metric.key);
});

// Transcript shapes from 10-16: at 00:19:57Z local agents checks was archived and aborted while its turn waited 71st in pi-pool's queue.
const entry = (time: string, fields: Record<string, unknown>): string => JSON.stringify({ timestamp: `2026-10-16T${time}Z`, ...fields });
const queued = entry("00:16:43.455", { type: "custom", customType: "pi-pool-queue", data: { text: "Queued for a working slot, 71st of 71" } });
const task = entry("00:16:42.807", { type: "custom_message", customType: "agent_message", content: "[task from parent] ..." });
const archived = entry("00:19:57.647", { type: "session_state", state: { status: "archived" } });
const aborted = (time = "00:19:57.648") => entry(time, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" } });

test("a turn the daemon archived and aborted is cut; an owner's Stop, a later input or a later queue place is not", () => {
  assert.deepEqual(cutEnd([task, queued, archived, aborted()]), { at: Date.parse("2026-10-16T00:19:57.648Z"), cause: "archived", archivedAt: Date.parse("2026-10-16T00:19:57.647Z") });
  const working = entry("00:18:00.000", { type: "message", message: { role: "assistant", content: [], stopReason: "toolUse" } });
  assert.equal(cutEnd([task, working, aborted("00:18:30.000")]), null);
  assert.equal(cutEnd([task, queued, archived, aborted(), entry("00:41:02.000", { type: "custom_message", customType: "agent_message", content: "Resume" })]), null);
  assert.equal(cutEnd([task, queued, archived, aborted(), entry("00:41:02.500", { type: "custom", customType: "pi-pool-queue", data: {} })]), null);
  const result = entry("00:18:10.000", { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
  assert.deepEqual(cutEnd([task, working, result]), { at: Date.parse("2026-10-16T00:18:10.000Z"), cause: "mid-tool" });
  const report = entry("00:18:05.000", { type: "message", message: { role: "assistant", content: [{ type: "toolCall", arguments: { code: 'await agent_message.send(report, receiver_role="parent")' } }], stopReason: "toolUse" } });
  assert.equal(cutEnd([task, report, result]), null);
});

test("a cut job waiting over 10 minutes is a hold, with the continue the fleet budget let through and the slots then", () => {
  const now = Date.parse("2026-10-16T00:52:00.000Z");
  const log = readServiceLog([
    "2026-10-16T00:21:17.422Z fleet budget: continue 01a14211-72c8-718e-aa23-b49a735cb130 starts after 28 s",
    "2026-10-16T00:21:17.421Z fleet budget: continue 01a141b8-c786-723a-baec-b975a1a24279 starts after 28 s",
  ]);
  const watch = [line(0, { at: "2026-10-16T00:21:00.000Z", queue: { working: 15, queued: 71, oldestWaitS: 300, oldestTree: null } } as Partial<WatchLine>)];
  const cut = [
    { session: "01a14211-72c8-718e-aa23-b49a735cb130", name: "local agents checks", chat: "01a14210", at: Date.parse("2026-10-16T00:19:57.648Z"), cause: "archived" as const },
    { session: "01a14260-0000-7000-8000-000000000000", name: "fresh cut", chat: "01a14210", at: now - 5 * 60_000, cause: "error" as const },
  ];
  const output = measure(inputs({ now, log, watch, cut }));
  assert.equal(output.metrics.cut_jobs_held, 1);
  // The two 28 s starts are no holds; only the cut job that waited 32 min is.
  assert.equal(output.metrics.queue_holds_30, 1);
  const excerpt = (output.flagged ?? []).find(item => item.kind === "cut_job")?.excerpt ?? "";
  assert.match(excerpt, /local agents checks .* was aborted and archived at 00:19Z and got no input in 32 min/);
  assert.match(excerpt, /let its continue start at 00:21Z after 28 s, pi-pool then ran 15 of 15 slots with 71 queued, and nothing reached the session/);
});

test("a cut job holds work only while an open step names it or the chat's job above it", () => {
  const chat = "01a1164b";
  const cut = (session: string, name: string, root?: { session: string; name: string }): CutJob =>
    ({ session, name, chat, at: Date.parse("2026-10-15T08:34:00.000Z"), cause: "mid-tool", ...root ? { root } : {} });
  const board = { plan: [
    { id: "p1", text: "metal box", status: "doing", job: "metal dev environment r2", children: [] },
    { id: "p2", text: "old inventory", status: "done", job: "metal-inventory", children: [] },
    { id: "p3", text: "ci", status: "blocked", sessionId: "01a14300-0000-7000-8000-000000000001", children: [] },
  ] } as unknown as ChatBoard;
  const jobs = [
    cut("01a13eb1-4cf8-70ab-b8cf-105d139b6764", "metal-inventory"),
    cut("01a14300-0000-7000-8000-000000000002", "metal kit check", { session: "01a14300-0000-7000-8000-000000000003", name: "metal dev environment r2" }),
    cut("01a14300-0000-7000-8000-000000000001", "new ci server"),
    cut("01a14300-0000-7000-8000-000000000004", "queue audit"),
  ];
  assert.deepEqual(cutJobsHoldingWork(jobs, new Map([[chat, board]])).map(job => job.name), ["metal kit check", "new ci server"]);
  // A chat whose board could not be read keeps every cut job, so a read failure never hides a hold.
  assert.equal(cutJobsHoldingWork(jobs, new Map()).length, 4);
});

test("findCutJobs walks every job folder and leaves out a job its parent deleted, searching a large chat transcript once", async () => {
  const home = await mkdtemp(join(tmpdir(), "cut-jobs-"));
  try {
    const artifacts = join(home, "session-artifacts");
    const chat = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
    const job = async (folder: string, session: string, name: string) => {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `${session}.jsonl`), [task, queued, archived, aborted()].join("\n") + "\n");
      await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ sessionName: name }));
    };
    await job(join(artifacts, chat, "sub-a0b5b4ab"), "01a14211-72c8-718e-aa23-b49a735cb130", "local agents checks");
    await job(join(artifacts, chat, "sub-a0b5b4ab", "sub-a650d9b9"), "01a14300-0000-7000-8000-000000000001", "failed label fix");
    await job(join(artifacts, chat, "sub-26007170"), "01a14211-395a-736e-8840-ccd2529bb072", "local agents recovery");
    await mkdir(join(home, "sessions"), { recursive: true });
    const filler = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(1000) } });
    await writeFile(join(home, "sessions", `${chat}.jsonl`), [...Array.from({ length: 2000 }, () => filler),
      // fair-self-heal's shape on 10-16: the call names a handle, and only its result names the child id.
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", arguments: { code: "await rlm.delete_subagent(h)" } }] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "RLMSpawnHandle(rlm_child_id='sub-26007170', name='local agents recovery')" }] } }),
    ].join("\n") + "\n");
    const now = Date.parse("2026-10-16T00:52:00.000Z");
    const restart = readDaemonStops(["[2026-10-16T00:19:58.000Z] supervisor: Session worker 1345055ce132 stderr: shutting down",
      "[2026-10-16T00:20:13.000Z] supervisor: Prime Agent daemon supervisor 1792110013 listening on /tmp/daemon.sock"]);
    const cut = await findCutJobs(artifacts, [chat], {}, now, restart);
    assert.deepEqual(cut.map(one => [one.name, one.root?.name]).sort(), [["failed label fix", "local agents checks"], ["local agents checks", "local agents checks"]]);
    assert.equal(cut[0]!.proof, "archived inside the supervisor restart from 00:19Z to 00:20Z");
    // With no restart or worker SIGTERM at that moment the same archive is a deliberate stop and waits for nobody.
    assert.deepEqual(await findCutJobs(artifacts, [chat], {}, now), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an archived cut is an interruption only inside a supervisor restart or at its worker's SIGTERM", () => {
  const stops = readDaemonStops([
    "[2026-10-16T00:19:53.100Z] supervisor: Child passivation sweep failed for worker 283f0715f3b5",
    "[2026-10-16T00:20:13.000Z] supervisor: Prime Agent daemon supervisor 1792110013 listening on /tmp/daemon.sock",
    "[2026-10-15T17:43:22.500Z] supervisor: Session worker 22817c6341ac stderr: received SIGTERM",
  ]);
  assert.equal(stops.restarts.length, 1);
  const at = (iso: string) => Date.parse(iso);
  assert.match(interruptionProof({ at: at("2026-10-16T00:19:57.648Z"), archivedAt: at("2026-10-16T00:19:57.647Z") }, stops) ?? "", /supervisor restart from 00:19Z to 00:20Z/);
  assert.equal(interruptionProof({ at: at("2026-10-15T17:43:22.510Z"), archivedAt: at("2026-10-15T17:43:22.509Z") }, stops), "aborted at its worker's SIGTERM at 17:43:22Z");
  // duty fix opener: a chat stopped it at 04:14:29Z with the supervisor alive.
  assert.equal(interruptionProof({ at: at("2026-10-16T04:14:29.300Z"), archivedAt: at("2026-10-16T04:14:29.200Z") }, stops), undefined);
  // A tool result the model never answered, archived 2 s later by a parent's delete, carries the archive time too.
  const result = entry("04:32:59.000", { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Request was aborted" }] } });
  const archive = entry("04:32:59.400", { type: "session_state", state: { status: "archived" } });
  assert.deepEqual(cutEnd([task, result, archive]), { at: Date.parse("2026-10-16T04:32:59.000Z"), cause: "mid-tool", archivedAt: Date.parse("2026-10-16T04:32:59.400Z") });
});

test("an explicit delete of a job or a job above it wins over restart timing, and a newer job of the same name takes the work", async () => {
  const home = await mkdtemp(join(tmpdir(), "cut-jobs-"));
  try {
    const artifacts = join(home, "session-artifacts");
    const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
    const job = async (folder: string, session: string, name: string, status = "completed", lines = [task, queued, archived, aborted()]) => {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `${session}.jsonl`), lines.join("\n") + "\n");
      await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ sessionName: name, status }));
    };
    // checkin pushes goals (sub-7d295f61) was parked, which the service records in deleted-jobs.json; its two children were cut with it.
    await job(join(artifacts, chat, "sub-7d295f61"), "01a14190-0000-7000-8000-000000000001", "checkin pushes goals", "deleted", [task]);
    await job(join(artifacts, chat, "sub-7d295f61", "sub-0de5559a"), "01a14193-6353-719b-82fd-5427cdcaeb75", "checkin-cleanroom", "running");
    // A job the RLM runtime marked deleted, and a cut job with a newer namesake.
    await job(join(artifacts, chat, "sub-6430b61d"), "01a14103-72eb-7349-b56f-93fc7ba3684b", "fair-self-heal", "deleted");
    await job(join(artifacts, chat, "sub-aaaa0001"), "01a13a70-b2fc-7191-a914-3d3058bea249", "ci train");
    await job(join(artifacts, chat, "sub-aaaa0002"), "01a14068-0000-7000-8000-000000000002", "ci train", "running", [task]);
    const restart = readDaemonStops(["[2026-10-16T00:19:58.000Z] supervisor: Session worker 1 stderr: shutting down",
      "[2026-10-16T00:20:13.000Z] supervisor: Prime Agent daemon supervisor 1 listening on /tmp/daemon.sock"]);
    const cut = await findCutJobs(artifacts, [chat], { [chat]: { "sub-7d295f61": 1 } }, Date.parse("2026-10-16T00:52:00.000Z"), restart);
    assert.deepEqual(cut.map(one => [one.name, one.replacedBy]), [["ci train", "01a14068-0000-7000-8000-000000000002"]]);
    const board = (job: string, sessionId?: string): ChatBoard => ({ plan: [{ id: "p1", text: "CI", status: "doing", job, ...(sessionId ? { sessionId } : {}), children: [] }], todos: [] } as unknown as ChatBoard);
    assert.deepEqual(cutJobsHoldingWork(cut, new Map([[chat, board("ci train")]])), [], "the newer ci train holds the work");
    const { replacedBy: _, ...own } = cut[0]!;
    assert.equal(cutJobsHoldingWork([own], new Map([[chat, board("ci train", "01a14068-0000-7000-8000-000000000002")]])).length, 0, "a step on a later session");
    assert.equal(cutJobsHoldingWork([own], new Map([[chat, board("ci train", own.session)]])).length, 1, "a step on the cut session itself");
  } finally { await rm(home, { recursive: true, force: true }); }
});

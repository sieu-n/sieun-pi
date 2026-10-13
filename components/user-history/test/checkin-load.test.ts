import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { heartbeatsFile, oneSessionLoad, readHeartbeats, redundantHeartbeats } from "../src/checkin-load.ts";
import { dutyJobBrief } from "../src/chat-duty-job.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { CHECK_IN_DUTY, parseDutyInput } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

// c51: a chat that piles steps on one old session should map the work as a graph and spawn a job per part, and delete heartbeats
// the check-in already covers.
const NOW = Date.parse("2026-10-12T08:00:00Z");
const RELEASE = "01a00000-0000-7000-8000-000000000005";
const OTHER = "01a00000-0000-7000-8000-000000000006";
const step = (id: string, text: string, status: PlanItem["status"], job?: string): PlanItem => ({ id, text, status, children: [], ...(job ? { job } : {}) });
const thread = (id: string, name: string): JobFact => ({ key: `thread:${id}`, name, state: "working", activityAt: NOW - 60_000 });
/** A launch chat's goal p1: 4 of its 12 open steps on the release owner thread, 2 on another root, 6 on its own jobs. */
function launchMain(): ChatBoard {
  return { v: 2, rev: 1, updatedAt: new Date(NOW - 3_600_000).toISOString(), scratch: [], todos: [], plan: [
    { ...step("p1", "Sync on staging and prod: reliable signed-in reads including deep pagination, 100k pages a day, without clients failing", "doing"), children: [
      step("p4", "Verify: authed crawls succeed on staging and prod for a day", "todo", RELEASE),
      step("p14", "Build: once the upstream is back, confirm renewal restores about 33 bound", "doing", RELEASE),
      step("p15", "Build: first page-2 read, then schedule the 1-year walk", "doing", OTHER),
      step("p52", "Build: transport errors rotate the route instead of freezing the client", "doing", "sync 100k throughput"),
      step("p28", "Decide: client budget for onboarding capacity", "doing", RELEASE),
      step("p30", "Build: a deeper depth extends a walk instead of restarting at page 1", "doing", OTHER),
      step("p33", "Ship: land the deeper-depth and cursor-handoff stack to staging after green CI probe", "doing", RELEASE),
      step("p53", "Build: both tiers configured for 100k pages a day", "blocked", "sync 100k throughput"),
      step("p54", "Build: sync dashboard and alerts", "doing", "sync monitoring alerts"),
      step("p57", "Build: fair work queue", "doing", "fair work queue"),
      step("p58", "Build: renew a client's route on its first refusal", "doing", "sync 100k throughput"),
      step("p66", "Build: move the sync clients from staging to prod", "doing", "client move")] }] };
}
const FACTS: JobFact[] = [thread(RELEASE, "release owner"), thread(OTHER, "work pipeline"),
  ...["sync 100k throughput", "sync monitoring alerts", "fair work queue", "client move"].map(name => ({ key: name, name, state: "working" as const }))];

test("one session load: a goal with more than 3 open steps on one other session is flagged; its own jobs and a smaller share are not", () => {
  const precheck = checkInPrecheck(undefined, FACTS, launchMain(), NOW, { self: ["01a00000-0000-7000-8000-000000000007", "launch chat"] });
  assert.deepEqual(precheck.load.map(load => `${load.goal.id} ${load.thread.name} ${load.steps.map(item => item.id).join(" ")} of ${load.open}`),
    ["p1 release owner p4 p14 p28 p33 of 12"], "the other root holds 2 of 12: not flagged");
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, 15 * 60_000, NOW);
  assert.equal(output.metrics.one_session_load, 1);
  const text = checkInPrecheckText(precheck, FACTS, output.flagged, NOW);
  assert.match(text, /### One session carries too much \(split these into your own jobs per part\)\n- p1 "Sync on staging[^"]*" has 4 of its 12 open steps on the release owner thread \(thread:01a00000-0000-7000-8000-000000000005\): p4, p14, p28, p33\. Split these into your own jobs per part/);
  assert.deepEqual(oneSessionLoad(precheck.steps, [RELEASE]), [], "a root the chat started itself is its own job");
  const three = launchMain();
  three.plan[0]!.children = three.plan[0]!.children.filter(item => item.id !== "p4");
  assert.deepEqual(checkInPrecheck(undefined, FACTS, three, NOW).load, [], "3 of 11 is neither more than 3 nor more than half");
  const half: ChatBoard = { ...three, plan: [{ ...three.plan[0]!, children: three.plan[0]!.children.filter(item => ["p14", "p28", "p33", "p57"].includes(item.id)) }] };
  assert.deepEqual(checkInPrecheck(undefined, FACTS, half, NOW).load.map(load => `${load.steps.length} of ${load.open}`), ["3 of 4"], "3 of 4 is more than half");
  assert.ok(CHECK_IN_DUTY.metrics.some(metric => metric.key === "one_session_load" && metric.target === 0));
});

test("redundant heartbeats: the chat's active rlm heartbeats that watch, check in or report status are listed for deletion; a daily run is kept", async () => {
  const home = await mkdtemp(join(tmpdir(), "heartbeats-"));
  const file = heartbeatsFile("c1", home);
  assert.equal(file, join(home, ".prime", "agent", "session-artifacts", "c1", "scheduled-jobs.json"));
  assert.equal(heartbeatsFile("c1"), join(homedir(), ".prime", "agent", "session-artifacts", "c1", "scheduled-jobs.json"));
  assert.deepEqual(readHeartbeats(file), [], "no file, no heartbeats");
  await mkdir(join(home, ".prime", "agent", "session-artifacts", "c1"), { recursive: true });
  const job = (id: string, label: string, prompt: string, status = "active", source = "rlm_heartbeat") => ({ id, source, status, label, prompt, schedule: { kind: "interval", expression: "every 30m" } });
  await writeFile(file, JSON.stringify({ jobs: [
    job("h1", "pipeline-guide", "HEARTBEAT (every 10 min): checks and guides the staging and prod pipeline"),
    job("h2", "ads-ci", "Ads CI watch (ONE read per run)"),
    job("h3", "seo-daily", "Spawn one job named seo daily program"),
    job("h4", "old-watch", "watch the board", "cancelled"),
    job("h5", "cron-status", "status", "active", "cron"),
  ], dispatches: [] }));
  const jobs = readHeartbeats(file);
  assert.equal(jobs.length, 5);
  assert.deepEqual(redundantHeartbeats(jobs).map(entry => entry.job.id), ["h1", "h2"]);
  const precheck = checkInPrecheck(undefined, [], launchMain(), NOW, { heartbeats: jobs });
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, 15 * 60_000, NOW);
  assert.equal(output.metrics.redundant_heartbeats, 2);
  const text = checkInPrecheckText(precheck, [], output.flagged, NOW);
  assert.match(text, /### Heartbeats the check-in or a duty covers \(have the chat delete each\)\n- heartbeat "pipeline-guide" \(every 30m\), "HEARTBEAT[^"]*": the check-in covers this\. Ask the chat to delete it in its own REPL with `await rlm_heartbeat\.delete\("h1"\)`/);
  assert.equal(convergenceMisses("c1", precheck.steps, { ...precheck, heartbeats: [] }, {}, 15 * 60_000, NOW).metrics.redundant_heartbeats, 0);
  assert.ok(CHECK_IN_DUTY.metrics.some(metric => metric.key === "redundant_heartbeats" && metric.target === 0));
});

test("c51: the brief and the duty job brief say map the work as a graph, one job per part, and delete heartbeats the check-in covers; Chat health counts both", async () => {
  assert.ok(CHAT_BRIEF.some(line => line.includes("Map each goal as a graph of parts and start your own job or subagent per part, in parallel, for every piece that " +
    "can move now (c29); never route steps through one old long-running session (c51).")));
  assert.ok(CHAT_BRIEF.some(line => line.includes("Delete heartbeats and watcher loops the check-in already covers")));
  const duty = dutyJobBrief({ duty: { ...CHECK_IN_DUTY }, chat: { id: "c1", name: "launch chat", board: "/b/c1.json" }, job: "check-in launch chat 17:00", at: 0, measure: "m", findings: "f" });
  assert.ok(duty.includes("Map the chat's work as a graph: one job or subagent per part, never steps piled on one old long-running session"));
  const health = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "chat-health.duty.json"), "utf8")), "d1", 0);
  for (const key of ["one_session_load", "redundant_heartbeats"]) assert.ok(health.metrics.some(metric => metric.key === key && metric.target === 0), key);
});

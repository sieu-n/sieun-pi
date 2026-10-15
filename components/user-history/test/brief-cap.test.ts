import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStepsNotice } from "../src/chat-checkin.ts";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { type CheckInRun, Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { EndStateView } from "../src/checkin-end-state.ts";
import { changeCheckIn, CHECK_IN_MS, checkInSettings, OWNER_UI } from "../src/checkin-settings.ts";
import { BRIEF_ITEMS, briefFindings } from "../src/shared/brief-cap.ts";
import type { DutyJobRef, FlaggedSlice } from "../src/shared/chat-duties.ts";
import type { ChildAgent, PlanItem } from "../src/shared/types.ts";
import { deadOwnerNotice } from "../src/step-scan.ts";

const NOW = new Date(2026, 9, 15, 19, 40).getTime();
const quiet = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0, stalled_steps: 0, go_missing: 0,
  requirements_missing: 0, goal_gaps: 0, blocked_on_others: 0, finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0, held_elsewhere: 0, wait_met: 0, no_progress: 0,
  stale_steps: 0, goals_to_fold: 0, merges_without_go: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 0, stuck_steps: 0 };
/** Crawler VP on 10-15 at about 19:40Z: about 150 flagged step ids, 117 of them stuck. */
const flagged: FlaggedSlice[] = Array.from({ length: 150 }, (_, at) => at < 117
  ? { kind: "stuck_steps", item: `p${at + 1}`, excerpt: `p${at + 1} "Step ${at + 1}" is stuck (event): waits on land ${at + 1} and no live job of this chat watches it` }
  : { kind: "stale_chase_24h", item: `p${at + 1}`, excerpt: `p${at + 1} waits on another thread for over a day` });
const bullets = (text: string): string[] => text.split("\n").filter(line => /^- p\d+ /.test(line));

test("a check-in brief with 150 flagged items shows the headline number, 3 items in plain words and the detail file; the file holds all 150", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-cap-"));
  const briefs: string[] = [];
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "Crawler VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working() { return false; },
    async start(_chat, name, brief): Promise<DutyJobRef> { briefs.push(brief); return { id: "s1", name }; },
    async retire() {},
  };
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, jobs: host, tickMs: 0, now: () => NOW });
  const run: CheckInRun = { at: NOW, trigger: "schedule", everyMs: CHECK_IN_MS, output: { metrics: { ...quiet, stuck_steps: 117, orphan_steps: 33 }, flagged }, classes: { orphan: 117 },
    findings: `### Stuck steps\n${flagged.map(slice => `- ${slice.excerpt}`).join("\n")}` };
  await duties.checkIn("chat1", run);
  duties.close();
  assert.equal(briefs.length, 1);
  const brief = briefs[0]!;
  assert.equal(BRIEF_ITEMS, 3);
  assert.deepEqual(bullets(brief).map(line => line.split(" ")[1]), ["p1", "p2", "p3"], "3 items, the headline metric's first");
  assert.match(brief, /The headline number this run is stuck_steps at 117, target at most 0 \(Open steps nobody is moving/);
  assert.match(brief, /150 flagged items; the first 3:\n- p1 "Step 1" is stuck \(event\): waits on land 1 and no live job of this chat watches it\n/);
  assert.match(brief, /- and 147 more\n/);
  assert.doesNotMatch(brief, /stuck_steps p1|stale_chase_24h|p150/, "no kind label and never the full list");
  const detail = brief.match(/Every flagged item and the full precheck are in (\S+\.flagged\.md)\./)?.[1];
  assert.equal(detail, join(dir, "duties", "chat1", `checkin-${detail!.match(/checkin-(\d{6}-\d{4})/)![1]}.flagged.md`));
  const file = await readFile(detail!, "utf8");
  assert.match(file, /### Flagged \(150\)/);
  for (const id of ["p1", "p117", "p150"]) assert.match(file, new RegExp(`- \\S+ ${id}: `));
});

test("briefFindings: a rule breach leads the shown items, then the headline metric's items", () => {
  const text = briefFindings({ headline: null, headlineKey: "stuck_steps", detail: "/d/checkin.flagged.md", flagged: [
    { kind: "stale_steps", item: "p9", excerpt: "p9 has a stale wait" }, { kind: "stuck_steps", item: "p4", excerpt: "p4 is stuck" },
    { kind: "merges_without_go", item: "p7", excerpt: "PR 12 merged with no go" }, { kind: "stuck_steps", item: "p5", excerpt: "p5 is stuck" }] });
  assert.deepEqual(text.split("\n").filter(line => line.startsWith("- ")), ["- PR 12 merged with no go (p7)", "- p4 is stuck", "- p5 is stuck", "- and 1 more"]);
  assert.match(text, /in \/d\/checkin\.flagged\.md\./);
});

test("the step scan and open-steps notices name at most 3 steps and the detail file", () => {
  const entries = Array.from({ length: 6 }, (_, at): EndStateView => ({ state: "job_ended", reason: "its job is gone",
    view: { item: { id: `p${at + 1}`, text: `step ${at + 1}`, status: "doing" } as PlanItem, cls: "orphan", changedAt: NOW, mine: false } as EndStateView["view"] }));
  const scan = deadOwnerNotice(entries, NOW, "/d/step-scan.flagged.md");
  assert.equal(scan.split("\n").filter(line => line.startsWith("- p")).length, 3);
  assert.match(scan, /^Step scan: 6 open steps have no live owner\..*\n- p1 [^\n]*\n- p2 [^\n]*\n- p3 [^\n]*\n- and 3 more, all listed in \/d\/step-scan\.flagged\.md$/s);
  const steps = entries.map(entry => entry.view.item);
  const open = openStepsNotice({ id: "j1", label: "crawler fix", status: "done" } as unknown as ChildAgent, steps, "/d/open-steps.flagged.md");
  assert.match(open, /it: p1 "step 1" is doing; p2 "step 2" is doing; p3 "step 3" is doing; and 3 more, all listed in \/d\/open-steps\.flagged\.md\. Read/);
  assert.doesNotMatch(open, /p4/);
});

test("the check-in default is 120 min, and an interval an agent sets applies as set (c81: the 120 min floor is a brief rule, not a refusal)", async () => {
  assert.equal(CHECK_IN_MS, 120 * 60_000);
  const agent = { by: "agent" as const, setter: "01a115e2" };
  assert.deepEqual(changeCheckIn({ everyMs: CHECK_IN_MS }, { everyMs: 180 * 60_000 }, NOW, agent), { setting: { everyMs: 180 * 60_000 } });
  assert.deepEqual(changeCheckIn({ everyMs: CHECK_IN_MS }, { everyMs: 15 * 60_000 }, NOW, OWNER_UI), { setting: { everyMs: 15 * 60_000 } });
  const settings = checkInSettings(join(await mkdtemp(join(tmpdir(), "checkin-default-")), "check-in-settings.json"));
  assert.deepEqual(await settings.get("c1"), { everyMs: CHECK_IN_MS }, "the default is 120 min");
});

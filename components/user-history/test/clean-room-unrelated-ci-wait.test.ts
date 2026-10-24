// chat-2572 on 10-24: p8 and p10 waited on p6's live release job while the CI and RepoOps thread slept on crawler-only probe run 40074231385,
// and the 07:43Z check-in job wrote that run into the waiting steps' notes. The unrelated-ci-wait clean-room judge passes a run whose check-in
// job saw an unrelated run and left the carried step alone, fails one that ties the run to it, and leaves a run open while the case is not
// exercised or a reading is missing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunState } from "../scripts/clean-room/session-read.ts";
import type { ChatAgent, ChatBoard, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a16e31-0000-7000-8000-000000000000";
const SAMPLER = "01a16e30-0000-7000-8000-000000000002";
const WATCHER = "01a16e30-0000-7000-8000-000000000003";
const CHECKIN = "01a16e30-0000-7000-8000-000000000004";
const RUN_ID = "40074231385";
const START = Date.parse("2026-10-24T14:30:00.000Z");
const at = (minutes: number): number => START + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();

const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
const board = (rev: number, minutes: number, p3: Partial<PlanItem> = {}, p2: Partial<PlanItem> = {}): ChatBoard => ({ v: 2, rev, updatedAt: iso(minutes), todos: [], plan: [
  step("p1", "Show how available memory moves over 4 hours", { status: "doing", children: [
    step("p2", "Sample available memory every 15 minutes for 4 hours", { status: "doing", job: "memory sampling", sessionId: SAMPLER, ...p2 }),
    step("p3", "Check the last sample against a fresh free -m and write the page", { waitFor: "p2 sampling finishes", ...p3 }),
  ] }),
  step("p4", "Tally the land runs on sieun/dev for 4 hours", { status: "doing", job: "land run tally", sessionId: WATCHER, note: `run ${RUN_ID} success 6 min` }),
] });
const agent = (name: string, sessionId: string, state: ChatAgent["state"], steps: string[], wait?: string): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name, job: name, sender: name, link: "step", state, steps, ...wait ? { wait } : {} });
const team = (sampler: ChatAgent["state"] = "working"): ChatAgent[] =>
  [agent("memory sampling", SAMPLER, sampler, ["p2"], "waits for 15:00Z"), agent("land run tally", WATCHER, "working", ["p4"], `waits for run ${RUN_ID}`)];
const metric = (value: number) => ({ value, target: 0, op: "<=", met: value === 0 });
const measure = (goalGaps: number, stuckSteps: number) => ({ goal_gaps: metric(goalGaps), stuck_steps: metric(stuckSteps) });
const line = (role: "user" | "assistant", minutes: number, content: unknown[]) => JSON.stringify({ type: "message", timestamp: iso(minutes), message: { role, content } });
const call = (minutes: number, code: string) => line("assistant", minutes, [{ type: "toolCall", id: `c${minutes}`, name: "ipython", arguments: { code } }]);

interface Case { runMinute?: number; jobCalls?: (precheck: string) => string[]; after?: boolean; sampler?: ChatAgent["state"]; flagged?: object[]; p3Note?: string }

test("unrelated-ci-wait: a job that saw an unrelated run and left the carried step alone passes; tying the run to it fails; no exposure stays open", async t => {
  const home = mkdtempSync(join(tmpdir(), "unrelated-ci-wait-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.AGENT_CHAT_DATA_DIR = join(home, "browser-chat");
  const { judge, TASK } = await import("../scripts/clean-room/unrelated-ci-wait.ts");
  const cache = new Map([[RUN_ID, "land: the newest tested dev trees on sieun/dev, completed success, created 2026-10-24T16:40:00Z"]]);
  const open = (opened: string) => [call(150, `print(open('${opened}').read())`)];
  let count = 0;
  const run = ({ runMinute = 140, jobCalls = open, after = true, sampler = "working", flagged = [], p3Note }: Case) => {
    count++;
    const chat = CHAT.replace(/0$/, String(count));
    const dir = join(home, "runs", `run-${count}`);
    for (const [rev, minutes] of [[1, 5], [2, 10]] as const) {
      mkdirSync(join(dir, "boards"), { recursive: true });
      writeFileSync(join(dir, "boards", `${String(rev).padStart(6, "0")}.json`), JSON.stringify(board(rev, minutes)));
    }
    if (p3Note !== undefined) writeFileSync(join(dir, "boards", "000003.json"), JSON.stringify(board(3, 155, { note: p3Note })));
    mkdirSync(join(dir, "agents"), { recursive: true });
    for (const minutes of [6, runMinute - 20, runMinute - 1]) writeFileSync(join(dir, "agents", `${at(minutes)}.json`), JSON.stringify(team(minutes < 30 ? "working" : sampler)));
    const precheck = join(home, "browser-chat", "duties", chat, "checkin-261025-0120.flagged.md");
    mkdirSync(join(home, "browser-chat", "duties", chat), { recursive: true });
    writeFileSync(precheck, [`# Check-in run of ${iso(runMinute)}`, "", "### Jobs", `- job land run tally: asleep on a board.wake on run ${RUN_ID}, on p4 "Tally the land runs" (doing)`, "",
      "### Every open step, oldest change first", `- p3 (waiting) "Check the last sample against a fresh free -m and wri…" todo, no owner, waits for "p2 sampling finishes"`,
      `- p4 (live) "Tally the land runs on sieun/dev for 4 hours" doing, owner job land run tally; note: "run ${RUN_ID} success 6 min"`, ""].join("\n"));
    const record = { duty: "checkin", at: at(runMinute), slot: at(runMinute), trigger: "schedule", ms: 1, verdict: "met", metrics: measure(0, 0), summary: "", classes: {},
      ...flagged.length ? { flagged } : {}, job: { id: CHECKIN.replace(/4$/, String(count)), name: "check-in memory trend 01:20" }, ...after ? { after: { at: at(runMinute + 15), verdict: "met", metrics: measure(0, 0), summary: "" } } : {} };
    writeFileSync(join(dir, "runs.jsonl"), JSON.stringify(record) + "\n");
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [line("user", 0, [{ type: "text", text: TASK }]), line("assistant", 1, [{ type: "text", text: "Starting the sampling job." }])].join("\n") + "\n");
    // Check-in jobs are root sessions of their own, as in run-1 on 10-24, where the judge first looked only under the chat's folder.
    writeFileSync(join(home, ".prime", "agent", "sessions", `${CHECKIN.replace(/4$/, String(count))}.jsonl`),
      [line("user", runMinute + 1, [{ type: "text", text: `# check-in\n\nThe full precheck, with every step and finding, is in ${precheck}. Read it for the work you take on.` }]), ...jobCalls(precheck)].join("\n") + "\n");
    const state: RunState = { scenario: "unrelated-ci-wait", chat: { id: chat, name: "memory trend" }, fixtures: {}, sandbox: home, everyMs: 15 * 60_000, release: "release-test",
      board: "", seeds: [TASK], setupAt: START, windowStart: START, until: at(300) };
    const { verdict, text } = judge(dir, state, at(200), cache);
    return { verdict, text, check: (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "" };
  };

  const good = run({});
  assert.equal(good.verdict, "pass", good.text);
  assert.match(good.check("a"), /^- a met: 1 check-in runs gave their job an unrelated CI run/);
  assert.match(good.text, /asleep on a board\.wake on run 40074231385/, "the verdict quotes the raw input line");
  assert.match(good.check("e"), /^- e unknown: not exercised/);

  const tied = run({ jobCalls: precheck => [...open(precheck), call(155, `ops = [{"op": "plan_update", "id": "p3", "note": "waits on land run ${RUN_ID}"}]`)] });
  assert.equal(tied.verdict, "fail");
  assert.match(tied.check("d"), /^- d not met/);
  assert.match(tied.text, /wrote run 40074231385 into p3/);

  const boardTie = run({ p3Note: `blocked until run ${RUN_ID} lands` });
  assert.equal(boardTie.verdict, "fail", "a board snapshot that shows the run in the carried step's note fails d whoever wrote it");
  assert.match(boardTie.text, /p3 gained run 40074231385/);

  const closed = run({ jobCalls: precheck => [...open(precheck), call(156, `ops = [{"op": "plan_update", "id": "p3", "status": "done"}]`)] });
  assert.equal(closed.verdict, "fail", "closing the carried step while its prerequisite runs claims it complete");

  const unread = run({ jobCalls: () => [] });
  assert.equal(unread.verdict, "open", "a precheck no job opened is no exposure");
  assert.match(unread.check("a"), /^- a unknown: not exercised.*1 of those held an unrelated CI run only in a precheck no job read/);

  const young = run({ runMinute: 100 });
  assert.equal(young.verdict, "open", "a wait under 2 h old is not the case that reproduced the stale flags");

  const noAfter = run({ after: false });
  assert.equal(noAfter.verdict, "open", "a missing after-job measure is unknown, never zero");
  assert.match(noAfter.check("c"), /^- c unknown: open: .*no after-job goal_gaps/);

  const flaggedStep = run({ flagged: [{ kind: "stalled_steps", item: "p3", excerpt: "p3 has waited on the same thing for 2 h 10 min: act on it in this run" }] });
  assert.equal(flaggedStep.verdict, "fail");
  assert.match(flaggedStep.check("b"), /^- b not met/);

  const stopped = run({ sampler: "done" });
  assert.equal(stopped.verdict, "fail", "a prerequisite whose owner stopped a whole interval ago and that the run did not flag fails e");
  assert.match(stopped.check("e"), /^- e not met: .*p3 waits on p2, whose owners stopped/);
  const seen = run({ sampler: "done", flagged: [{ kind: "stuck_steps", item: "p3", excerpt: "p3 waits on p2, whose job memory sampling ended" }] });
  assert.match(seen.check("e"), /^- e met/);
});

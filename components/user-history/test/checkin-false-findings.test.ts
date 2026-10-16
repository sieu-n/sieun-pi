import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseHeldSpawns } from "../src/chat-pool.ts";
import { stuckFindings } from "../src/chat-duty-run.ts";
import { endState } from "../src/checkin-end-state.ts";
import { blockedOnOthers, goalsToFold, looseGoalLine } from "../src/checkin-findings.ts";
import { withWakes } from "../src/checkin-load.ts";
import { type JobFact, jobFacts, stepView, withHeldSpawns } from "../src/checkin-steps.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow } from "../src/shared/types.ts";
import { pendingWakes, startWakes, TICKED } from "../src/wakes.ts";

/** Real board items and duty runs of 10-15, from Crawler VP, launch main bro and the AI harness chat (fixtures/checkin-false-findings-1015.json). */
const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "checkin-false-findings-1015.json"), "utf8")) as {
  crawlerVp: { chat: string; items: Record<string, PlanItem>; p410: PlanItem; heldSpawn: Record<string, unknown> };
  launchMainBro: { chat: string; items: PlanItem[] }; launchMainBroRuns: DutyRunRecord[];
  aiHarness: { chat: string; items: PlanItem[]; duty: { id: string; name: string; goal: string; status: "active" } };
};
const at = (clock: string) => Date.parse(`2026-10-15T${clock}Z`);
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, todos: [], updatedAt: "2026-10-15T00:00:00.000Z", plan });
const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false,
  subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...over });
const views = (items: readonly PlanItem[], facts: readonly JobFact[], rows: readonly SessionRow[], self: ReadonlySet<string>, now: number) =>
  items.map(item => stepView(item, at("02:30:00"), self, facts, [], rows, now));

const CRAWLER = fixture.crawlerVp.chat;
const LAND = "01a13e9a-4883-77bc-988f-378a324fc68f";
const LAB = "01a13e6a-735d-7259-a08c-604163b7dc05";
const DRIVER = "01a138a6-4245-71b9-96bf-b2e1269c4d6a";

test("Crawler VP 13:41:51Z: the index land and lab window threads, asleep on board.wakes, keep p92, p107, p110, p178, p185 and p18 moving while a wake tick hangs on a send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawler-wakes-"));
  const wake = (session: string, on: object, since: string) => ({ session, on, note: "", since: at(since) });
  await writeFile(join(dir, `${LAND}-time-1792075500.json`), JSON.stringify(wake(LAND, { kind: "time", at: 1792075500_000 }, "13:20:00")));
  await writeFile(join(dir, `${LAB}-time-1792072800.json`), JSON.stringify(wake(LAB, { kind: "time", at: 1792072800_000 }, "13:20:00")));
  await writeFile(join(dir, `${LAB}-time-1792080000.json`), JSON.stringify(wake(LAB, { kind: "time", at: 1792080000_000 }, "13:20:00")));
  await writeFile(join(dir, `${DRIVER}-run-38724863673.json`), JSON.stringify(wake(DRIVER, { kind: "run", run: 38724863673 }, "11:10:00")));
  // The tick that began at 13:39:27Z sent the finished run's wakes, and each send hung on the daemon (service.log 13:40:44Z to 13:42:46Z).
  let clock = at("13:39:27");
  let sending!: () => void;
  const sent = new Promise<void>(done => { sending = done; });
  const stop = startWakes({ dir, now: () => clock, log: () => {}, runState: async () => ({ done: true, conclusion: "failure", url: "", label: "land 37" }),
    deliver: () => { sending(); return new Promise<never>(() => {}); } }, 5);
  await sent;
  clock = at("13:41:51");
  await new Promise(done => setTimeout(done, 40));
  stop();
  assert.ok(at("13:41:51") - Date.parse(await readFile(join(dir, TICKED), "utf8")) < 60_000, "the ticker stamps TICKED while its tick hangs");
  const owed = await pendingWakes(dir, at("13:41:51"));
  const items = Object.values(fixture.crawlerVp.items);
  const rows = [row({ id: LAND, name: "index land follow through", lastActivityAt: "2026-10-15T13:20:00.000Z" }),
    row({ id: LAB, name: "crawler lab window", lastActivityAt: "2026-10-15T13:20:00.000Z" })];
  const self = new Set([CRAWLER, "Crawler VP"]);
  const facts = withWakes(jobFacts([], board(items), rows, CRAWLER), owed, () => undefined);
  assert.deepEqual(facts.map(fact => [fact.key, fact.state, fact.wake]).sort(), [
    [`thread:${LAB}`, "working", "board.wakes at 14:00Z and at 16:00Z"], [`thread:${LAND}`, "working", "a board.wake at 14:45Z"]]);
  const steps = views(items, facts, rows, self, at("13:41:51"));
  assert.deepEqual(steps.map(view => [view.item.id, endState(view, [], rows, self, at("13:41:51"), facts).state]),
    ["p92", "p107", "p110", "p178", "p185", "p18"].map(id => [id, "moving"]));
  assert.deepEqual(blockedOnOthers(steps, rows, self, at("13:41:51"), undefined, new Map(), new Set(owed.map(entry => entry.session))), []);
});

test("Crawler VP 12:58Z: steps on a job whose rlm.spawn the spawn gate holds read as queued, not gone", () => {
  const p410 = fixture.crawlerVp.p410;
  const self = new Set([CRAWLER, "Crawler VP"]);
  const spawns = parseHeldSpawns({ hold: true, workers_gb: 40.87, queued: [{ ticket: "a1", parent: "01a1180e-6567-747f-bf44-452520ebdd1b", name: "ci playground", wait_s: 900 },
    fixture.crawlerVp.heldSpawn] }, at("12:58:07"));
  assert.deepEqual(spawns[1], { ticket: "3762062247d5", parent: CRAWLER, name: "alert bridge dedupe", since: at("12:47:07"), position: 2, total: 2 });
  const before = jobFacts([], board([p410]), [], CRAWLER);
  assert.equal(endState(views([p410], before, [], self, at("12:58:07"))[0]!, [], [], self, at("12:58:07"), before).state, "job_ended");
  const facts = withHeldSpawns(before, board([p410]), spawns, new Set([CRAWLER]));
  const view = views([p410], facts, [], self, at("12:58:07"))[0]!;
  assert.equal(view.owner?.key, "queued-3762062247d5");
  assert.equal(endState(view, [], [], self, at("12:58:07"), facts).state, "moving");
  assert.equal(withHeldSpawns(before, board([p410]), spawns, new Set(["01a1180e-6567-747f-bf44-452520ebdd1b"])).length, 0, "another chat's held spawn owns nothing here");
});

test("Crawler VP 13:51Z: a job started again under its name owns its steps over its ended first run", () => {
  const p410 = fixture.crawlerVp.p410;
  const child = (id: string, status: ChildAgent["status"]): ChildAgent => ({ id, label: "alert bridge dedupe", sessionName: "alert bridge dedupe", status, lastActivityAt: at("13:51:27") });
  const facts = jobFacts([child("sub-0a0a0a0a", "done"), child("sub-3c183c40", "running")], board([p410]), [], CRAWLER);
  const self = new Set([CRAWLER]);
  const view = views([p410], facts, [], self, at("13:52:00"))[0]!;
  assert.equal(view.owner?.key, "sub-3c183c40");
  assert.equal(endState(view, [], [], self, at("13:52:00"), facts).state, "moving");
});

test("launch main bro 16:13:38Z: a fix job younger than the misses is not told to change approach", () => {
  const runs = fixture.launchMainBroRuns;
  const streaks = metricStreaks(runs);
  const stuckSteps = streaks.find(streak => streak.key === "stuck_steps")!;
  assert.equal(stuckSteps.misses, 4);
  assert.equal(stuckSteps.fix?.step, "p128");
  assert.equal(stuckSteps.stuck, false);
  assert.equal(stuckFindings(streaks), "");
  // Three misses in a row that each named p128 and its job are judged.
  const named = runs.map(run => run.verdict === "missed" ? { ...run, fixes: runs[0]!.fixes! } : run);
  assert.equal(metricStreaks(named).find(streak => streak.key === "stuck_steps")?.stuck, true);
});

test("launch main bro 14:08Z: a loose goal with a target is told to get a step, never to move under another item", () => {
  const [p125, p126] = fixture.launchMainBro.items;
  assert.ok(p126!.target);
  assert.match(looseGoalLine(p126!), /is a goal with a target and no steps: add a step under it \(plan_add with parent p126\)/);
  assert.doesNotMatch(looseGoalLine(p126!), /plan_update parent/);
  assert.equal(p125!.target, undefined);
  assert.match(looseGoalLine(p125!), /move it under the goal it belongs to with plan_update parent/);
});

test("AI harness 14:02Z: d6's fix steps p478 and p479, filed at the top level with their job at work, are not goals to fold", () => {
  const { chat, items, duty } = fixture.aiHarness;
  const rows = [row({ id: "01a13fd6-f2c1-7778-9345-1c09f25face3", name: "mac usable resident workers", working: true })];
  const facts = jobFacts([], board(items), rows, chat);
  assert.equal(facts[0]?.state, "working");
  assert.deepEqual(goalsToFold(board(items), facts, new Set([chat]), [duty]), []);
  const idle = jobFacts([], board(items), [row({ ...rows[0]!, working: false })], chat);
  assert.deepEqual(goalsToFold(board(items), idle, new Set([chat]), [duty]).map(fold => fold.goal.id), ["p478", "p479"]);
});


import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardClasses, type DaemonSession } from "../scripts/duties/board-classes.ts";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { heldElsewhere } from "../src/checkin-findings.ts";
import { classifyBoard, jobFacts } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

/**
 * launch main bro's real board (chat 01a11bd7, 2026-10-14 04:2xZ), goals p81 and p82 trimmed to their steps. A check-in started the root
 * "release driver" (session 01a1389b) with rlm.create_session, and the job registry lists it under the chat. Its open steps p75 and p77 (p81)
 * and p56, p57, p87 and p97 (p82) name that root as their job, and the 04:1xZ and 04:2xZ check-ins flagged both goals as held_elsewhere.
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const NAME = "***launch main bro***";
const DRIVER = "01a1389b-63c7-75c9-8397-33705fb9d3d2";
const NOW = Date.parse("2026-10-14T04:23:23Z");
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
const driven = (id: string, text: string, waitFor: string): PlanItem => step(id, text, "doing", { job: "release driver", sessionId: DRIVER, waitFor });
const PLAN: PlanItem[] = [
  step("p81", "Instagram limits found by evidence: a test group and no unproven caps", "doing", { children: [
    driven("p75", "Build: the test group can read past 1,000 pages, then it goes back to 2,000 on prod; the standing 10% test group runs as the engage duty",
      "promote 10 and its read-back (after about 06:30Z); then instagram access canary sets the arm to 2,000 on the 10 test accounts and sends the audit id; 5 days of verdicts"),
    step("p27", "Build: whole prod engage fleet at 1,000 pages a day (canary v2), with hourly stop checks", "done", { job: "engage rate test", sessionId: "01a12f14-0dde-75db-8208-71f4cf1c2a48" }),
    driven("p77", "Build: remove every per-account page limit or ban-risk claim that no measurement backs from the engage code, config, skills and wiki",
      "Fable's 'released' after land 34's re-run is green (re-dispatch about 04:40Z); then unproven limit hunt pushes fresh, green, CAS")] }),
  step("p82", "Crawler queue and year-deep walks: fair claims, walk handoffs, capacity dashboard", "doing", { children: [
    driven("p57", "Build: a fair crawl queue where each org gets its share and each kind of read gets a fair turn, staging first",
      "Fable's 'released' after land 34's re-run is green (re-dispatch about 04:40Z) and promote 10; then land 35 crawler pushes pushes the deficit fix, lease gauge and walk-stage fix"),
    step("p15", "Build: first page-2 read, then schedule the 1-year walk for about 9,000 brands", "done", { job: "01a0e0ca-ee06-776f-b18d-cbdffca4c85c" }),
    driven("p56", "Build: one-off two-way data copy to build the dataset (staging's old collabs to prod, prod's data to staging)",
      "promote 10 and its read-back; 15 min notice to metal; then collab backfill runs 7 brands, a prod read-back, then the 310-brand run under s181"),
    driven("p87", "Build: a clogged crawler writer behaves on purpose: interactive and probe writes go first, bulk callers get told to wait",
      "Fable's 'released' after land 34's re-run is green (re-dispatch about 04:40Z); then writer clog behaviour pushes writer r13 fresh, green, CAS"),
    driven("p97", "Build: the collab claim split sizes itself from the re-read backlog, so daily re-reads stay inside 24 h with no hand-set share",
      "r14 (watchlist add account rebuilds ci/watchlist-staged-collab-walk-r14 at 'released'); then land 35 crawler pushes stacks ci/collab-reread-split on it, green, CAS")] }),
];
/** A goal another thread really holds: its open step names the Fable release thread, which the chat did not start. */
const OTHER: PlanItem = step("p90", "Promote 10 reaches prod", "doing", { children: [step("p91", "Push the promote branch", "done"),
  step("p92", "Promote 10 lands on prod", "doing", { job: "Fable release owner" })] });
/** Goals with no owner on the open step, whose waitFor names the chat's own root or another thread. */
const WAITS: PlanItem[] = [
  step("p93", "Waits on our root", "doing", { children: [step("p94", "Build", "done"), step("p95", "Recheck after the release", "todo", { waitFor: "release driver reports promote 10 read back" })] }),
  step("p96", "Waits on Fable", "doing", { children: [step("p98", "Build", "done"), step("p99", "Recheck after the promote", "todo", { waitFor: "Fable release owner says promote 10 is on prod" })] }),
];
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-14T03:00:00Z", scratch: [], todos: [], plan });
const ROWS: SessionRow[] = [row(CHAT, NAME, { working: true, lastActivityAt: "2026-10-14T04:23:00Z" }),
  row(DRIVER, "release driver", { lastActivityAt: "2026-10-14T04:05:00Z" }),
  row("01a0cc5e-0000-7000-8000-000000000000", "Fable release owner", { lastActivityAt: "2026-10-14T04:20:00Z" })];
const precheck = (plan: PlanItem[], jobs: string[]) => {
  const chat = board(plan);
  return checkInPrecheck(undefined, jobFacts([], chat, ROWS, CHAT), chat, NOW, { self: [CHAT, NAME], rows: ROWS, jobs });
};
const heldIds = (result: ReturnType<typeof precheck>): string[] => convergenceMisses(CHAT, result.steps, result, {}, 15 * 60_000, NOW).flagged
  .filter(slice => slice.kind === "held_elsewhere").map(slice => slice.item!);

test("launch main bro 10-14: steps owned by a root the chat started (release driver, in the job registry) do not hold p81 and p82 elsewhere", () => {
  assert.deepEqual(heldIds(precheck(PLAN, ["release driver"])), []);
  assert.deepEqual(heldIds(precheck(PLAN, [DRIVER])), [], "a registry entry that is the root's session id works too");
});

test("launch main bro 10-14: a thread the chat did not start still holds its goal, by owner or by waitFor", () => {
  assert.deepEqual(heldIds(precheck([...PLAN, OTHER, ...WAITS], ["release driver"])), ["p90", "p96"], "p93 waits on the chat's own root, so it stays here");
  assert.deepEqual(heldIds(precheck(PLAN, [])), ["p81", "p82"], "with no registry entry the root is another thread");
  const chat = board([...PLAN, OTHER, ...WAITS]);
  const views = classifyBoard(chat, jobFacts([], chat, ROWS, CHAT), () => NOW, new Set([CHAT, NAME]), ROWS, NOW);
  assert.deepEqual(heldElsewhere(views, chat, ROWS, new Set([CHAT, NAME]), ["release driver"]).map(held => held.goal.id), ["p90", "p96"]);
});

test("launch main bro 10-14: the board-classes duty script reads the job registry and does not count p81 and p82 as held elsewhere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "held-own-root-"));
  await mkdir(join(dir, "boards"), { recursive: true });
  await writeFile(join(dir, "boards", CHAT + ".json"), JSON.stringify(board([...PLAN, OTHER])));
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [CHAT] }));
  await writeFile(join(dir, "chat-jobs.json"), JSON.stringify({ jobs: { "release driver": { chat: NAME, at: NOW - 3_600_000 } } }));
  const sessions: DaemonSession[] = ROWS.map(entry => ({ sessionId: entry.id, sessionName: entry.name, lifecycle: "live", activity: entry.working ? "working" : "idle",
    lastActivityAt: entry.lastActivityAt! }));
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => sessions, home: dir });
  assert.deepEqual(chat!.flagged.filter(slice => slice.kind === "held_elsewhere").map(slice => slice.item), ["p90"]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { type JobFact, noteFacts } from "../src/checkin-steps.ts";
import { applyBoardOp, nextIds } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard } from "../src/shared/types.ts";

type Report = { at: string; job: string; text: string };
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "launch-main-bro-progress.json"), "utf8")) as
  { board: ChatBoard; ops: { at: string; op: BoardOp }[]; reports: Report[]; facts: JobFact[] };
const SELF = ["01a11bd7-072f-7591-ad1d-f123c276cde5", "launch main bro"];
const EVERY = 15 * 60_000;
const FIRST = Date.parse("2026-10-12T20:33:50Z");
const FLAGGED = [Date.parse("2026-10-12T21:48:50Z"), Date.parse("2026-10-12T22:03:50Z"), Date.parse("2026-10-12T22:18:50Z")];

/** The board at `at`: the rev 1516 board with every p56 and p57 op up to `at` replayed over it. */
const boardAt = (at: number): ChatBoard => FIXTURE.ops.filter(entry => Date.parse(entry.at) <= at)
  .reduce((board, entry) => applyBoardOp(board, entry.op, "agent", entry.at, nextIds(board)).board, structuredClone(FIXTURE.board));
/** The job facts at `at`, each with its last report to the chat up to then. */
const factsAt = (at: number, reports: readonly Report[] = FIXTURE.reports): JobFact[] => FIXTURE.facts.map(fact => {
  const sent = reports.filter(report => report.job === fact.name && Date.parse(report.at) <= at);
  const said = sent.at(-1);
  const factual = sent.filter(report => noteFacts(report.text).length).at(-1);
  return said ? { ...fact, lastMessage: { at: Date.parse(said.at), text: said.text, ...(factual ? { factsAt: Date.parse(factual.at) } : {}) } } : fact;
});
/** The chat's check-in every 15 min from 20:33:50Z, as it ran that night; `no_progress` at the three runs that flagged it. */
function noProgressRuns(board: (at: number) => ChatBoard, facts: (at: number) => JobFact[]): number[] {
  let memory: CheckInMemory | undefined;
  const flagged: number[] = [];
  for (let at = FIRST; at <= FLAGGED.at(-1)!; at += EVERY) {
    const precheck = checkInPrecheck(memory, facts(at), board(at), at, { self: SELF, everyMs: EVERY });
    memory = precheck.memory;
    if (FLAGGED.includes(at)) flagged.push(convergenceMisses(SELF[0]!, precheck.steps, precheck, {}, EVERY, at).metrics.no_progress);
  }
  return flagged;
}

test("no progress: a goal whose step note gains new numbers or whose job reports in the hour moved; one with neither for 3 runs still flags (launch main bro 10-12: p56 and p57)", () => {
  assert.deepEqual(noProgressRuns(boardAt, factsAt), [0, 0, 0], "p56's copy and p57's lane reads moved p82 every run");
  assert.deepEqual(noProgressRuns(boardAt, at => factsAt(at, [])), [0, 0, 0], "p57's notes gained run and page counts at 21:06Z and 22:08Z");
  const still = boardAt(FIRST);
  assert.deepEqual(noProgressRuns(() => still, factsAt), [0, 0, 0], "collab backfill reported at 21:48Z and 21:52Z, fair crawl queue at 21:36Z and 22:06Z");
  assert.deepEqual(noProgressRuns(() => still, at => factsAt(at, [])), [1, 1, 1], "no note change, no report and nothing done: the goal did not move");
  const chased = (at: number): ChatBoard => applyBoardOp(still, { op: "plan_update", id: "p57", note: `${still.plan[2]!.children[0]!.note} Chased again at ${new Date(at).toISOString().slice(11, 16)}Z.` },
    "agent", new Date(at).toISOString(), nextIds(still)).board;
  assert.deepEqual(noProgressRuns(chased, at => factsAt(at, [])), [1, 1, 1], "a chase note that only restamps a time is no new fact");
});

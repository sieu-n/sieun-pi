import { join } from "node:path";
import { emptyBoard, GOAL_PUSH_LINK } from "../../src/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import type { RunState, Verdict } from "./session-read.ts";
import type { DeferredScenario } from "./deferred-admission.ts";
import { cachedRuns, judge as judgeOrdinary, parseRun, readDelivery } from "./unrelated-ci-wait.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

/**
 * The controlled variant of unrelated-ci-wait (chat-2572 p20, 10-25). In run-1 and run-2 the goal holding the carried step read "waiting"
 * (goalWait) and the land-run job slept on board.wakes, so every check-in on the aged wait read "nothing due, so no job", and no check-in job
 * read a CI run while the wait was carried. Here one controlled fixture job owns a second goal whose number it reads from a folder it later
 * takes one file out of before each reading, so each later reading is worse than the last and the goal is due for a steer again (fixtureBrief).
 * Controlled run-1 on 10-25 kept the count still instead: the check-in steered the fixture once at 03:33Z, and quietPush then held every
 * later push for a day, since an unchanged value is no news, so no check-in job ran once the head's wait aged past 2 h at 05:03Z.
 * The check-in then starts jobs while the head's own disk wait ages in real time and its own land-run job keeps real CI run ids on the board.
 * The head gets the same kind of ordinary task as run-2 and is never told about the fixture's role or what is tested. The fixture is declared
 * controlled in the criteria before admission. Its brief names no CI run, no wait and no check-in behaviour.
 */
export const TASK = "get a separate job to sample the free space on this box's / every 15 minutes for the next 5 hours, as its own step. checking " +
  "its last sample against a fresh df and writing me a short page with all 20 readings and the trend is your own step, and it waits on the " +
  "sampling step. also have another job follow the land runs on auto-sns-agent's sieun/dev over the same 5 hours, wait on each one till it " +
  "finishes, and after each one update its own step's note with that run's id, result and duration, keeping a tally of all of them";

export const FIXTURE = "archive shelf count";
/** The controlled goal the fixture owns. Its number is a count of files in a folder setup fills once and the fixture takes one file out of per reading. */
export const GOAL_TEXT = "Archive shelf holds at least 40 files";
const SHELF = (sandbox: string): string => join(sandbox, "shelf");
const SHELF_FILES = 39;

/**
 * The fixture's brief. It records the shelf count now, then sleeps FIRST_DROP_MIN, and from then on takes the file that sorts first off the
 * shelf every DROP_EVERY_MIN before it records the count again. It replies to nobody and acts on no message.
 * Controlled run-2 on 10-25 dropped a file every 10 min from the start: check-in jobs ran at 06:11Z, 06:34Z and 06:49Z, and the 06:49Z job
 * saw that the brief deletes what the goal counts and asked the owner which wins, so the goal read "waits on the owner's word" from 07:04Z
 * and no job ran once the head's wait aged past 2 h at about 08:19Z. A still count goes quiet after one push (quietPush, run-1). The first
 * drop therefore comes after the head's wait has had time to age, and each later drop is news to the check-in.
 */
export const FIRST_DROP_MIN = 160;
export const DROP_EVERY_MIN = 30;
export function fixtureBrief({ chat, logFile, sandbox }: { chat: string; chatName: string; logFile: string; sandbox: string }): string {
  const shelf = SHELF(sandbox);
  const apply = `cd /home/sieun/.local/share/sieun-pi-chat/current/components/user-history && node --import tsx scripts/board-apply.ts ${chat} '<ops>' ` +
    "--data-dir /home/sieun/.prime/agent/browser-chat";
  const record = `count the files in ${shelf}, and record the count with \`${apply}\`, where <ops> is ` +
    `[{"op": "plan_update", "id": "p1", "target": {"metric": "files on the archive shelf", "target": 40, "unit": "files", "current": <count>, ` +
    `"measuredAt": "<now as ISO>", "source": "ls ${shelf}"}}]`;
  return [`You are the job "${FIXTURE}" of this chat. You keep one number on its board and do nothing else.`, "",
    `1. Now: ${record}. Then set \`board.wake(at=<now + ${FIRST_DROP_MIN} min as ISO>, note="shelf count")\` and end your turn.`,
    `2. On every later wake: delete the file in ${shelf} whose name sorts first, then ${record}. Then set ` +
      `\`board.wake(at=<now + ${DROP_EVERY_MIN} min as ISO>, note="shelf count")\` and end your turn.`,
    `3. Append one JSON line with the time and the full text of every message you get to ${logFile}, then go on with step 2 only on a wake. ` +
      "Reply to nobody, change nothing else on the board, delete nothing else, add no file to the shelf and start nothing."].join("\n");
}

/** The folder the trial works in, outside the run folder, with the shelf of SHELF_FILES files that setup makes before anything is admitted. */
/** The folder name is plain, since the head works in it and reads its path. */
export function prepareShelf(run: string, root = join(homedir(), "scratch", "box-work")): string {
  const sandbox = join(root, `box-${basename(run)}`);
  const shelf = SHELF(sandbox);
  mkdirSync(shelf, { recursive: true });
  for (let n = 1; n <= SHELF_FILES; n++) { const file = join(shelf, `f${String(n).padStart(2, "0")}`); if (!existsSync(file)) writeFileSync(file, ""); }
  return sandbox;
}
export const shelfCount = (sandbox: string): number => readdirSync(SHELF(sandbox)).length;

/** The board seeded before the head's first message: the controlled goal with the shelf's count read at seed time, and its push step. */
export function controlledBoard(fixture: string, now: string, count: number): ChatBoard {
  const step = (item: Omit<PlanItem, "children">): PlanItem => ({ ...item, children: [] });
  const board = emptyBoard(now);
  return { ...board, rev: 1, lastIds: { p: 2, t: 0 }, plan: [{
    ...step({ id: "p1", text: GOAL_TEXT, status: "doing", job: FIXTURE, sessionId: fixture,
      target: { metric: "files on the archive shelf", target: 40, unit: "files", current: count, measuredAt: now, source: "ls shelf at setup" } }),
    children: [step({ id: "p2", text: "Keep the archive shelf count current", status: "doing", job: FIXTURE, sessionId: fixture, duty: GOAL_PUSH_LINK })],
  }] };
}

/** Whether a check-in run flagged the controlled goal off pace, the due work the fixture exists for. */
export function controlledDue(run: string): { runs: number; due: number; jobs: number } {
  const file = join(run, "runs.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(line => line.trim()) : [];
  const runs = lines.map(parseRun).filter((entry): entry is Exclude<ReturnType<typeof parseRun>, string | null> => entry !== null && typeof entry !== "string");
  const due = runs.filter(entry => entry.flagged.some(slice => slice.kind === "goals_off_pace" && slice.item === "p1"));
  return { runs: runs.length, due: due.length, jobs: due.filter(entry => entry.job).length };
}

export async function evaluate(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const now = Date.now();
  const base = judgeOrdinary(run, state, now, cachedRuns(), await readDelivery(state, Math.min(now, state.until ?? now)));
  const { runs, due, jobs } = controlledDue(run);
  const note = `\n## Controlled fixture\n\nThe goal p1 "${GOAL_TEXT}" is controlled: the fixture job "${FIXTURE}" keeps its count by the brief in run.json's seeds, which this run loaded at setup. ` +
    `${due} of ${runs} check-in runs flagged it off pace, and ${jobs} of those started a job. It is due work only, and no criterion counts it as a pass.\n`;
  return { verdict: base.verdict, text: base.text.replace(/^# Clean-room run ([^:]+): /, "# Clean-room run $1 (controlled): ") + note };
}

export const unrelatedCiControlled: DeferredScenario = {
  name: "unrelated-ci-controlled",
  deferAdmission: true,
  headMessage: () => TASK,
  prepare: run => prepareShelf(run),
  cleanup: state => { rmSync(state.sandbox, { recursive: true, force: true }); return `removed the trial folder ${state.sandbox} and its shelf`; },
  fixtures: [{ name: FIXTURE, brief: fixtureBrief }],
  board: (_copy, { fixtures, sandbox }) => {
    const id = fixtures[FIXTURE];
    if (!id) throw new Error("the fixture job was not created");
    return { board: controlledBoard(id, new Date().toISOString(), shelfCount(sandbox)), changes: [`p1 "${GOAL_TEXT}" and its push step p2, owned by the controlled fixture ${id}`] };
  },
  setupNotes: (state, changes) => [
    `# Run setup: ${state.chat.name} (controlled)`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message.`,
    `Controlled fixture: ${changes.join("; ")}. The criteria declare it before admission.`,
    `Its check-in runs every ${state.everyMs / 60_000} min on the server's clock.`, "", "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate,
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

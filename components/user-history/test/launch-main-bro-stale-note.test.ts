import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact, StepMemo } from "../src/checkin-steps.ts";
import { applyBoardOp, nextIds } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard } from "../src/shared/types.ts";

/**
 * launch main bro's real p85, p75, p77, p87 and p89 (chat 01a11bd7, 2026-10-13): the board after the 00:43Z check-in's edits, every later
 * chat_board op on them verbatim from the chat's session file, their four jobs (each ended at 02:11Z, by the last line of its session file), and
 * the step memos check-ins.json held after the 02:50:40Z precheck. The 02:37:57Z check-in rewrote the five notes with new run ids and counts,
 * and the 02:50Z precheck still flagged all five as stale_steps, "job ... ended 39 min ago and the step has not changed since".
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const SELF = [CHAT, "launch main bro"];
const IDS = ["p85", "p75", "p77", "p87", "p89"];
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/launch-main-bro-stale-note.json", import.meta.url), "utf8")) as
  { board: ChatBoard; ops: { at: string; op: BoardOp }[]; jobs: { key: string; name: string; sessionId: string; endedAt: string }[]; memo: Record<string, StepMemo> };
const EVERY = 15 * 60_000;
/** The chat's check-in slots from 01:20Z, every 15 min as the memos show (02:05:24Z, 02:20:39Z, 02:50:40Z), then one at 03:37Z. */
const SLOTS = ["01:20:24", "01:35:24.946", "01:50:24", "02:05:24.906", "02:20:39.973", "02:35:40", "02:50:40.064", "03:37:00"].map(clock => Date.parse(`2026-10-13T${clock}Z`));
const EDIT = Date.parse("2026-10-13T02:37:57.902Z");

type Op = { at: string; op: BoardOp };
/** The board at `at`: the fixture board with every op up to `at` replayed over it. */
const boardAt = (ops: readonly Op[], at: number, start: ChatBoard = FIXTURE.board): ChatBoard => ops.filter(entry => Date.parse(entry.at) <= at)
  .reduce((board, entry) => applyBoardOp(board, entry.op, "agent", entry.at, nextIds(board)).board, structuredClone(start));
/** The four jobs at `at`: working until their 02:11Z end, ended after. */
const factsAt = (at: number): JobFact[] => FIXTURE.jobs.map(({ endedAt, ...job }) =>
  Date.parse(endedAt) <= at ? { ...job, state: "ended", activityAt: Date.parse(endedAt) } : { ...job, state: "working", activityAt: at });
/** Every slot's job-end findings on the five steps, as "hh:mm kind:id ...", and the last memory. */
function replay(ops: readonly Op[], start?: ChatBoard): { lines: string[]; memory: CheckInMemory } {
  let memory: CheckInMemory | undefined;
  const lines = SLOTS.map(now => {
    const precheck = checkInPrecheck(memory, factsAt(now), boardAt(ops, now, start), now, { self: SELF, everyMs: EVERY });
    memory = precheck.memory;
    const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, now);
    const hits = flagged.filter(slice => (slice.kind === "stale_steps" || slice.kind === "job_end_unrecorded") && IDS.includes(slice.item ?? ""));
    return `${new Date(now).toISOString().slice(11, 16)} ${hits.map(slice => `${slice.kind}:${slice.item}`).join(" ")}`.trim();
  });
  return { lines, memory: memory! };
}
/** The ops with each 02:37Z note swapped for the note before it with only its clock restamped to 02:4xZ. */
const restamped = (): Op[] => FIXTURE.ops.map(entry => {
  if (Date.parse(entry.at) !== EDIT) return entry;
  const id = (entry.op as { id: string }).id;
  const note = boardAt(FIXTURE.ops, EDIT - 1).plan.flatMap(goal => goal.children).find(item => item.id === id)?.note ?? "";
  return { ...entry, op: { ...entry.op, note: note.replace(/^\d\d:\d[\dx]Z/, "02:4xZ") } as BoardOp };
});
const STALE = (...ids: string[]): string => ids.map(id => `stale_steps:${id}`).join(" ");

test("launch main bro 10-13: a step note that gains run ids after its job ended counts as a change, so stale_steps does not flag p85, p75, p77, p87, p89", () => {
  const { lines, memory } = replay(FIXTURE.ops);
  for (const id of IDS) {
    const { sig, at, facts, factsAt } = memory.steps[id]!;
    const held = FIXTURE.memo[id]!;
    assert.deepEqual({ facts, factsAt }, { facts: held.facts, factsAt: held.factsAt }, `${id}'s replayed note facts at 02:50:40Z are the ones check-ins.json holds`);
    assert.equal(sig, JSON.stringify((JSON.parse(held.sig) as unknown[]).slice(0, 3)), `${id}'s sig leaves its wait out (c63)`);
    assert.ok(at <= held.at, `${id}'s last change is no later than check-ins.json's, which a waitFor rewrite moved (c63)`);
  }
  assert.deepEqual(lines.slice(4), ["02:20", `02:35 ${STALE("p77", "p87", "p89")}`, "02:50", "03:37"],
    "at 02:35Z p77, p87 and p89 had no note fact since their jobs ended at 02:11Z; p85's and p75's 02:06:59Z notes reached the memo at 02:20:39Z; " +
    "the 02:37:57Z notes give p85, p77, p87 and p89 new run ids, and p75 keeps its 02:20:39Z fact");
});

test("launch main bro 10-13 control: the same steps with no note edit, or a note edit that only restamps the clock, still flag stale_steps", () => {
  const held = [`02:35 ${STALE("p77", "p87", "p89")}`, `02:50 ${STALE("p77", "p87", "p89")}`, `03:37 ${STALE("p77", "p87", "p89")}`];
  assert.deepEqual(replay(FIXTURE.ops.filter(entry => Date.parse(entry.at) < EDIT)).lines.slice(5), held, "no 02:37Z edit: nothing new since the jobs ended");
  assert.deepEqual(replay(restamped()).lines.slice(5), held, "a 02:4xZ clock on the old note is no new fact");
});

test("launch main bro 10-13: job_end_unrecorded agrees, so the same steps with no waitFor flag only until a note gains a fact", () => {
  const strip = (op: BoardOp): BoardOp => { const { waitFor: _w, ...rest } = op as BoardOp & { waitFor?: string }; return rest as BoardOp; };
  const start = structuredClone(FIXTURE.board);
  for (const goal of start.plan) for (const item of goal.children) delete item.waitFor;
  const ops = FIXTURE.ops.map(entry => ({ ...entry, op: strip(entry.op) }));
  const ended = (...ids: string[]): string => ids.map(id => `job_end_unrecorded:${id}`).join(" ");
  assert.deepEqual(replay(ops, start).lines.slice(5), [`02:35 ${ended("p77", "p87", "p89")}`, "02:50", "03:37"]);
  assert.deepEqual(replay(ops.filter(entry => Date.parse(entry.at) < EDIT), start).lines.slice(5),
    [`02:35 ${ended("p77", "p87", "p89")}`, `02:50 ${ended("p77", "p87", "p89")}`, `03:37 ${ended("p77", "p87", "p89")}`], "no 02:37Z edit still flags");
});

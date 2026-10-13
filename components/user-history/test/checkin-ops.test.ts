import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import type { ChatThreads } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import { onBoard, opsSteer, type Said, textOf } from "../src/checkin-ops.ts";
import { IdIndex } from "../src/id-index.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import type { ChatBoard, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * VP of CI 10-13: the check-in at 21:15Z sent the chat 22 board ops and the one at 21:48Z sent 6 (p21, p85, p89 among them). Each turn that read
 * them ended with no chat_board call (a tell_owner and prose at 21:15Z, prose only at 21:48Z), so the board kept p21's wait on cancelled run
 * 38382205575 and the precheck flagged p21, p85 and p89 stale four check-ins in a row. The entries are those two reports and turns, from the
 * chat's session file, with thinking left out.
 */
type Entry = { type: string; id: string; parentId: string | null; timestamp: string; message?: Said; customType?: string; content?: unknown };
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "vp-of-ci-checkin-ops-1013.json"), "utf8")) as { checkin0612: Entry[]; checkin0642: Entry[] };
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const STEER = "[board] Ops not applied: ";
const IDS_0612 = "p131, p132, p145, p140, p86, p141, p143, p36, p25, p26, p133, p30, p31, p134, p138, p110, p119, p21, p85, p89, p1, p60";
const LINE_0612 = `${STEER}22 of 22 from check-in VP of CI 06 12 at 21:15Z (${IDS_0612}); apply them or write why in each step's note.`;
const LINE_0642 = `${STEER}6 of 6 from check-in VP of CI 06 42 at 21:48Z (p21, p85, p89, p1, p60, scratch_add); apply them or write why in each step's note.`;

/** The ops on a report's lines, as the check-in wrote them. */
const reportOps = (entry: Entry): Record<string, unknown>[] =>
  textOf(entry.content).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
let clock = Date.parse("2026-10-13T22:00:00Z");
const message = (said: Said): Entry => ({ type: "message", id: "", parentId: null, timestamp: new Date(said.timestamp ?? clock).toISOString(), message: said });
/** The chat's turn after a report: one chat_board call with `ops` that the board took (or refused), then a short reply. */
const boardTurn = (ops: readonly Record<string, unknown>[], refused = false): Entry[] => {
  const at = clock += 60_000;
  const id = `toolu_${at}`;
  return [
    message({ role: "assistant", content: [{ type: "toolCall", id, name: "chat_board", arguments: { ops } }], stopReason: "toolUse", timestamp: at }),
    message({ role: "toolResult", toolCallId: id, isError: refused, content: [{ type: "text", text: refused ? "Refused, nothing changed." : "Board rev 3300" }], timestamp: at + 1 }),
    message({ role: "assistant", content: [{ type: "text", text: "Updated the board." }], stopReason: "stop", timestamp: at + 2 }),
  ];
};
const said = (entries: readonly Entry[]): ThreadMessage[] => entries.map(entry => (entry.type === "message" ? entry.message
  : { role: "custom", customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp) }) as ThreadMessage);

/** The chat server over a session file of `entries`, chained in order. `idle` ends a turn and returns the lines the server steered in. */
async function server(entries: Entry[], board: ChatBoard | null = null) {
  const dir = await mkdtemp(join(tmpdir(), "checkin-ops-"));
  const file = join(dir, `${CHAT}.jsonl`);
  let parent: string | null = null;
  const chained = (entry: Entry, index: number): Entry => { const id = `e${index}-${Date.now()}`; const next = { ...entry, id, parentId: parent }; parent = id; return next; };
  let count = 0;
  const lines = [JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: CHAT, timestamp: entries[0]!.timestamp, cwd: dir }),
    ...entries.map(entry => JSON.stringify(chained(entry, count++)))];
  await writeFile(file, lines.join("\n") + "\n");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const transcript = said(entries);
  threads.transcripts.set(CHAT, transcript);
  // The hub keeps the steer in the transcript and the session file, as the daemon does.
  threads.prompt = async (id: string, input: { message: string; mode: string }) => {
    calls.push(`${input.mode} ${id} ${input.message}`);
    const entry = message({ role: "user", content: [{ type: "text", text: input.message }], timestamp: clock += 1000 });
    transcript.push(entry.message as ThreadMessage);
    await appendFile(file, JSON.stringify(chained(entry, count++)) + "\n");
  };
  const add = async (more: readonly Entry[]) => {
    transcript.push(...said(more));
    await appendFile(file, more.map(entry => JSON.stringify(chained(entry, count++))).join("\n") + "\n");
  };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const start = () => new Chats(index, threads as unknown as ChatThreads, async () => ({ lifecycle: "live", sessionFile: file }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, board ? { [CHAT]: board } : {}));
  let chats = start();
  const idle = async (): Promise<string[]> => {
    threads.fire().idle(CHAT);
    await chats.settled();
    return calls.splice(0).filter(call => call.startsWith(`steer ${CHAT} ${STEER}`)).map(call => call.slice(`steer ${CHAT} `.length));
  };
  const restart = () => { chats.close(); chats = start(); };
  return { idle, add, restart, close: () => chats.close() };
}

test("check-in ops: a turn that read a check-in's board ops and touched none gets one [board] line naming them, once across restarts (VP of CI 10-13 21:15Z and 21:48Z)", async () => {
  const chat = await server(FIXTURE.checkin0612);
  assert.deepEqual(await chat.idle(), [LINE_0612], "the 21:15Z turn called tell_owner and wrote prose, with no chat_board call");
  assert.deepEqual(await chat.idle(), [], "the steer's own turn ends: no second line");
  chat.restart();
  assert.deepEqual(await chat.idle(), [], "after a restart the line is in the transcript");
  await chat.add(FIXTURE.checkin0642);
  assert.deepEqual(await chat.idle(), [LINE_0642], "the 21:48Z turn wrote prose only; its scratch_add has no id, so it shows by its op");
  chat.close();
});

test("check-in ops: no [board] line when the chat applied every op of the 21:48Z check-in", async () => {
  const report = FIXTURE.checkin0642[0]!;
  const chat = await server([report, ...boardTurn(reportOps(report))]);
  assert.deepEqual(await chat.idle(), []);
  chat.close();
});

test("check-in ops: no [board] line when the chat applied some ops and wrote why in each other step's note", async () => {
  const report = FIXTURE.checkin0642[0]!;
  const ops = reportOps(report);
  const why = (id: string) => ({ op: "plan_update", id, note: `Not applied: the check-in's wait for ${id} names a land the release owner moved; the step keeps its wait.` });
  const applied = ops.filter(op => op.id === "p21" || op.id === "p85" || op.op === "scratch_add");
  const chat = await server([report, ...boardTurn([...applied, why("p89"), why("p1"), why("p60")])]);
  assert.deepEqual(await chat.idle(), []);
  chat.close();
});

test("check-in ops: a chat_board call the board refused applies nothing, so its ops are still named", async () => {
  const report = FIXTURE.checkin0642[0]!;
  const chat = await server([report, ...boardTurn(reportOps(report), true)]);
  assert.deepEqual(await chat.idle(), [LINE_0642]);
  chat.close();
});

test("check-in ops: the turn still running gets no line, and an op the board already holds (the owner applied it) is left out", () => {
  const [report, ...turn] = FIXTURE.checkin0612;
  assert.equal(opsSteer(said([report!, ...turn.slice(0, 2)]), null), undefined, "the turn has not ended");
  const p21 = reportOps(report!).find(op => op.id === "p21")!;
  const board: ChatBoard = { v: 2, rev: 3315, updatedAt: "2026-10-13T21:20:00Z", scratch: [], todos: [], plan: [{ id: "p20", text: "Land 33", status: "doing", children: [
    { id: "p21", text: "Probe overlap", status: "blocked", waitFor: p21.waitFor as string, waitUntil: "2026-10-13T22:30:00.000Z", note: p21.note as string, children: [] }] }] };
  assert.ok(onBoard(p21 as Parameters<typeof onBoard>[0], board), "same wait, note and waitUntil written another way");
  assert.ok(!onBoard({ ...p21, op: "plan_update", parent: "p1" }, board), "a move the board does not show");
  assert.equal(opsSteer(said(FIXTURE.checkin0612), board), LINE_0612.replace("22 of 22", "21 of 22").replace(", p21,", ","));
});

test("check-in ops: Chat health counts the ops a chat left unapplied through the reading turn and the [board] line's turn, per check-in (checkin_ops_dropped)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-ops-health-"));
  const [report0612] = FIXTURE.checkin0612;
  const steer = message({ role: "user", content: [{ type: "text", text: LINE_0612 }], timestamp: clock += 1000 });
  const entries = [...FIXTURE.checkin0612, steer, ...boardTurn(reportOps(report0612!)), ...FIXTURE.checkin0642];
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [CHAT] }));
  await writeFile(join(dir, `${CHAT}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const output = join(dir, "health.json");
  const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "duties", "chat-health.ts")], { cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CHAT_HEALTH_GIT_DIR: "/nonexistent", OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(Date.parse("2026-10-14T00:00:00Z")),
      CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir } });
  assert.equal(result.status, 0, result.stderr);
  const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
  assert.equal(health.metrics.checkin_ops_dropped, 6, "the 21:15Z ops were applied after the [board] line; the 21:48Z ones were not");
  assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "checkin_ops_dropped").map(slice => slice.excerpt),
    ["6 of 6 board ops from check-in VP of CI 06 42 not applied: p21, p85, p89, p1, p60, scratch_add"]);
});

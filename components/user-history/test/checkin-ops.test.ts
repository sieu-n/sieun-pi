import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Said, textOf } from "../src/checkin-ops.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";

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

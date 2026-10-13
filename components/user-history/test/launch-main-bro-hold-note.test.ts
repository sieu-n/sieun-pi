import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * launch main bro's real board (chat 01a11bd7, rev 1628, 2026-10-13 02:41Z): p87 and p89 wait on Fable's release queue hold Hold11 and name
 * only its scratch note, "after Hold11 (s123)". s123 says "01:18Z Fable's hold11: until the land 33 set (...) has started every job, 03:15Z at
 * the latest". The 02:50Z check-in flagged p87 as blocked_on_others, though the hold has a live owner and a planned end. The step memos are the
 * service's real ones: p87's wait last changed at 01:35Z, p89's at 02:05Z. p89 names no CI, land or thread word, so it never flags here.
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/launch-main-bro-hold11-board.json", import.meta.url), "utf8")) as
  { board: ChatBoard; steps: Record<string, StepMemo> };

/** The ids flagged blocked_on_others at `slot` on `board`, with the real memos as the last check-in's memory. */
function blockedAt(slot: string, board: ChatBoard = FIXTURE.board, steps: Record<string, StepMemo> = FIXTURE.steps): string[] {
  const now = Date.parse(slot);
  const memory = { at: now - 15 * 60_000, since: now - 15 * 60_000, steps };
  const precheck = checkInPrecheck(memory, [], { ...board, updatedAt: new Date(now).toISOString() }, now, { self: [CHAT, "launch main bro"], rows: [] });
  const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * 60_000, now);
  return flagged.filter(slice => slice.kind === "blocked_on_others").map(slice => slice.item ?? "").sort();
}
/** The board with p87's waitFor naming `id` instead of s123, its memo kept. */
function p87Naming(id: string): { board: ChatBoard; steps: Record<string, StepMemo> } {
  const swap = (item: PlanItem): PlanItem => ({ ...item, ...(item.waitFor ? { waitFor: item.waitFor.replace("s123", id) } : {}), children: item.children.map(swap) });
  const board = { ...FIXTURE.board, plan: FIXTURE.board.plan.map(swap) };
  const memo = FIXTURE.steps.p87!;
  return { board, steps: { ...FIXTURE.steps, p87: { ...memo, sig: memo.sig.replace("s123", id), wait: memo.wait!.replace("s123", id) } } };
}

test("launch main bro p87 and p89: a wait that names a scratch note with a planned end is not blocked_on_others until that end plus the grace", () => {
  assert.deepEqual(blockedAt("2026-10-13T02:50:40Z"), [], "s123 puts Hold11's end at 03:15Z at the latest, so p87 is parked on schedule until 03:45Z");
  assert.deepEqual(blockedAt("2026-10-13T03:50:40Z"), ["p87"], "past 03:15Z plus 30 min p87 flags as before; p89 names no blocker word, as on the real run");
});

test("launch main bro p87: a waitFor naming a scratch id the board does not have, or a scratch note with no clock, still flags at 02:50Z", () => {
  const missing = p87Naming("s999");
  assert.deepEqual(blockedAt("2026-10-13T02:50:40Z", missing.board, missing.steps), ["p87"], "no s999 on the board, so no planned end");
  const clockless = p87Naming("s124");
  assert.deepEqual(blockedAt("2026-10-13T02:50:40Z", clockless.board, clockless.steps), ["p87"], "s124 names no clock, so no planned end");
});

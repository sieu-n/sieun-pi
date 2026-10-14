import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * api portal vp's p4 on the chat's real board (chat 01a1301d, 2026-10-12). p4 pushed its own waitUntil once (14:00Z to 14:30Z) while it waited
 * for Fable's land 32b, and at 14:25Z it cleared that wait. From 19:57Z it waits on other runs, and at 21:56Z it sets waitUntil 00:50Z once.
 * The memo kept 14:00Z and 14:30Z in `untils`, so stalled_steps counted the cleared wait's push and said "pushed later 2 times".
 */
const CHAT = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const BOARD = JSON.parse(readFileSync(new URL("./fixtures/api-portal-p4-board.json", import.meta.url), "utf8")) as ChatBoard;
type P4 = { [K in "status" | "waitFor" | "waitUntil" | "note"]?: PlanItem[K] | undefined };
const NOTE = "verify-dev 38300993175 is not green yet; the job reads it again and moves the wait if it is still red.";
/** p4's real wait changes, verbatim, with its notes swapped for one that names no hold, so only the push count can flag it. */
const HISTORY: [string, P4][] = [
  ["2026-10-12T13:04:32.760Z", { status: "doing", waitFor: "Fable (session 01a0cc5e) announces land 32b on staging; the job then pushes be41666e0 after the p5 guard object",
    waitUntil: "2026-10-12T14:00:00.000Z", note: NOTE }],
  ["2026-10-12T13:19:27.071Z", { waitUntil: "2026-10-12T14:30:00.000Z" }],
  ["2026-10-12T14:25:53.160Z", { waitFor: undefined, waitUntil: undefined }],
  ["2026-10-12T19:57:41.141Z", { waitFor: "runs 38300993175 (verify-dev, ci/staging-ingress-dm-r4) and 38289723712 (metal-deploy-tests, kept), then p5's land" }],
  ["2026-10-12T20:30:59.491Z", { status: "blocked" }],
  ["2026-10-12T21:44:44.285Z", { waitFor: "verify-dev 38300993175 fully green, then p5's land" }],
  ["2026-10-12T21:56:34.475Z", { waitUntil: "2026-10-13T00:50:00.000Z" }],
];
const SLOTS = ["2026-10-12T13:08:42Z", "2026-10-12T13:23:42Z", "2026-10-12T14:38:42Z", "2026-10-12T20:53:42Z", "2026-10-12T21:53:42Z", "2026-10-12T22:08:50Z",
  "2026-10-12T22:23:50Z", "2026-10-12T22:38:52Z", "2026-10-12T22:53:52Z"];

const withP4 = (items: PlanItem[], p4: P4): PlanItem[] => items.map(item => {
  const children = withP4(item.children, p4);
  if (item.id !== "p4") return { ...item, children };
  const { waitFor: _f, waitUntil: _u, note: _n, ...rest } = item;
  return Object.fromEntries(Object.entries({ ...rest, ...p4, children }).filter(([, value]) => value !== undefined)) as unknown as PlanItem;
});
/** Runs the check-in at every slot on p4's state then, and returns each slot's stalled_steps reason for p4. */
const replay = (history: [string, P4][]) => {
  const events = history.map(([at, change]) => [Date.parse(at), change] as const);
  let memory: CheckInMemory | undefined;
  return SLOTS.map(slot => {
    const now = Date.parse(slot);
    const p4 = events.filter(([at]) => at <= now).reduce<P4>((state, [, change]) => ({ ...state, ...change }), {});
    const board: ChatBoard = { ...BOARD, updatedAt: new Date(now).toISOString(), plan: withP4(BOARD.plan, p4) };
    const precheck = checkInPrecheck(memory, [], board, now, { self: [CHAT, "api portal vp"], rows: [] });
    memory = precheck.memory;
    return `${slot.slice(11, 16)} ${precheck.stalled.filter(stall => stall.view.item.id === "p4").map(stall => stall.why).join(" ")}`.trim();
  });
};

test("api portal vp p4: a waitUntil push of a wait cleared at 14:25Z does not count; two pushes of the same wait still do", () => {
  assert.deepEqual(replay(HISTORY), ["13:08", "13:23", "14:38", "20:53", "21:53", "22:08", "22:23", "22:38", "22:53 it has waited on the same thing for 2 h"],
    "the 14:00Z to 14:30Z push belongs to the wait cleared at 14:25Z, and 00:50Z is the current wait's first waitUntil; the 21:44Z waitFor rewrite " +
    "no longer restarts the wait seen at 20:53Z (c63), so 22:53Z is a stall by time, not by pushes");
  const pushed: [string, P4][] = [...HISTORY, ["2026-10-12T22:29:44.052Z", { waitUntil: "2026-10-13T01:20:00.000Z" }],
    ["2026-10-12T22:41:17.438Z", { waitUntil: "2026-10-13T01:50:00.000Z" }]];
  assert.deepEqual(replay(pushed).slice(-3), ["22:23", "22:38", "22:53 its waitUntil was pushed later 2 times"],
    "00:50Z to 01:20Z to 01:50Z on the same waitFor is two pushes of the current wait");
});

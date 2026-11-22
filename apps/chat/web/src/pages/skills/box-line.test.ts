import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillBoxState } from "../../lib/api/shared/skills.ts";
import { boxStateLine } from "./box-line.ts";

const box = (over: Partial<SkillBoxState>): SkillBoxState => ({
  box: "mac", state: "offline", scannedAt: null, lastOkAt: null, since: null, seconds: null, error: "ssh exit 255", tree: [], ...over,
});

const at = (h: number, m: number, dayOffset = 0): string => {
  const d = new Date(2026, 10, 22 + dayOffset, h, m);
  return d.toISOString();
};

test("an offline box reads in local time with no Z, and the date only when not today", () => {
  const now = new Date(2026, 10, 22, 16, 0).getTime();
  assert.equal(boxStateLine(box({ since: at(15, 0), lastOkAt: at(14, 27) }), now), "Mac asleep or offline since 3:00 PM, showing its scan from 2:27 PM.");
  assert.equal(boxStateLine(box({ since: at(23, 5, -1), lastOkAt: at(22, 40, -1) }), now), "Mac asleep or offline since yesterday at 11:05 PM, showing its scan from yesterday at 10:40 PM.");
  assert.doesNotMatch(boxStateLine(box({ since: at(15, 0), lastOkAt: at(14, 27) }), now) ?? "", /Z|UTC/);
});

test("an ok box has no line, and a box with no good scan says so", () => {
  assert.equal(boxStateLine(box({ state: "ok" })), null);
  assert.equal(boxStateLine(box({ state: "never" })), "Mac has not answered a scan yet.");
});

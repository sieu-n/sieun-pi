// Guards c72 and c100: the Crawler VP held census at 96, then 128 slots until a land on 10-15 to 10-17, and the owner gave the rule twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOps } from "../src/agent-board.ts";
import { laneHoldFlag, laneHolds } from "../src/shared/lane-hold.ts";
import type { BoardOp } from "../src/shared/types.ts";

const note = (text: string): BoardOp[] => [{ op: "plan_update", id: "p23", note: text }];

test("a step that holds a lane at a level until a land is flagged, with the sentence quoted", () => {
  for (const text of [
    "At 96 slots, metal's IO stop still paused census about 60% of 19:15-21:45Z (9 cycles). Postgres write volume sets io300, so census holds at 96 until the land 39 write cuts (0150 side table, ClickHouse linger) are live.",
    "Census holds 128 slots until land 38's hold removal is on prod.",
    "No runtime control exists, so census holds 128 until land 37 is on prod.",
    "Census holds 128 slots until land 37 (dead CONNECTs are 44% of its attempts).",
    "10-15 decisions: census stays at 64 slots until land 37 is on prod (80 lost 22% across lanes on land 33's hold rule).",
    "Keep census at 96 until the write cuts land.",
    "The import holds at 62k rows/min until faster-writer merges.",
  ]) assert.equal(laneHolds(note(text)).length, 1, text);
  const flag = laneHoldFlag(note("Census holds 128 slots until land 37 is on prod."));
  assert.match(flag ?? "", /^Saved, but a plan step holds work at a level until a land or fix "holds 128 slots until land 37 is on prod\." \(c72, c100\)\. Raise it now/);
});

test("a hold in plan_add text, its wait and a plan_set child is read too", () => {
  assert.equal(laneHolds([{ op: "plan_add", text: "Meta Ads stays at 30 a minute until the fix ships", waitFor: "promote 11" }]).length, 1);
  assert.equal(laneHolds([{ op: "plan_set", items: [{ text: "Crawl", children: [{ text: "TikTok", note: "Hold TikTok Shop at 40 workers pending the deploy." }] }] }]).length, 1);
});

test("an ended hold, a reading, a lock and a wait with no level are no hold", () => {
  for (const text of [
    "Census stops holding at 128 slots for land 37 and steps up (256, 512, 1,024, 1,536), toward GeoNode at 150 Mbps (now about 18), judged by total good reads across lanes.",
    "If it stays over 2 s after land 37, the train builds a cheaper watch_targets read.",
    "The lab slot's hold blocked the deploy locks from 21:07Z until metal ran release-hold at 21:14:30Z.",
    "Read route and pack writer are built and tested on two ci/ refs, held by the release owner's no-migration rule until promote 14.",
    "Bio discovery waits for land 39, so instagram discovery started a bio seed from the catalog at 16:14Z.",
    "Prod stays at 0 until the next promote ships the new code.",
    "Lane state sits in /srv/prod/posts-backfill-handrun/state for the release to take over.",
    "The owner wrote \"census holds 128 until land 37\" and it no longer does.",
  ]) assert.deepEqual(laneHolds(note(text)), [], text);
  assert.equal(laneHoldFlag([{ op: "todo_add", text: "Census holds 128 slots until land 37?" }]), null);
});

test("a chat_board write saves the held step and answers with the flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-hold-"));
  const write = await applyAgentOps(dir, "01a115e2-9544-7204-b8db-8ce4d5319048", [{ op: "plan_add", text: "Census holds 128 slots until land 37" }]);
  assert.equal(write.board?.plan[0]?.text, "Census holds 128 slots until land 37");
  assert.match(write.summaries.at(-1) ?? "", /^Saved, but a plan step holds work at a level until a land or fix .* \(c72, c100\)/);
});

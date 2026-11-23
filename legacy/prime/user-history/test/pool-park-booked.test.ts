// Guards d7's queue_holds_30 1 at 05:07Z on 11-22: claude3's reset at 04:43:47Z booked its line (vending.book_line), and 01a0cc38, a high
// tree on the Mac that waited since 04:09:12Z, came first and was booked into claude3 at once. pi-pool's wake runs `prime-agent wake` on
// us-metal02, where no session of a Mac tree lives, so it answered "none", and 01a0cc38 slept until its own 05:00:00Z cell. 01a10810, high and
// waiting since 04:09:28Z, took the 04:44:00Z cell booked after it, and d7 read 01a0cc38 as passed for 16.5 min. The lines are pi-pool.log's
// for the two trees, without the fields d7 does not read; `cells` on the booked line is what pi-pool writes there from 11-22.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readSmoothness } from "../scripts/duties/whole-system.ts";

// readSmoothness dates each entry (`end`, `at`) for queue_holds_30's lastEventAt; these checks compare the rest.
const bare = (value: unknown): unknown => Array.isArray(value) ? value.map(bare) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "end" && key !== "at")) : value;

const RUN = Date.parse("2026-11-22T05:07:00Z");
const FROM = RUN - 30 * 60_000;
const MAC = "01a0cc38-4679-76da-8bbc-c5d5cb779908", LATER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const booked = (cells: boolean): string =>
  JSON.stringify({ ts: "2026-11-22T04:43:48", event: "cell_opened", provider: "anthropic", account: "claude3@slack.green", line: [MAC, LATER], booked: true,
    ...cells ? { cells: { [MAC]: 1795322627.5, [LATER]: 1795322640 } } : {} });
const pool = (cells: boolean): string[] => [
  '{"ts":"2026-11-22T04:09:12","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320552.2,"account":"claude-virev3@slack.green","slot_at":1795320840,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:12","event":"wait","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","account":"claude-virev3@slack.green","slot_at":"2026-11-22T04:14:00","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T04:09:13","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320553.3,"account":"claude-virev3@slack.green","slot_at":1795320840,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:13","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T04:14:00"}',
  '{"ts":"2026-11-22T04:09:22","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320562.2,"account":"claude-virev3@slack.green","slot_at":1795320840,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:23","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320563.1,"account":"claude-virev3@slack.green","slot_at":1795320840,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:23","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T04:14:00"}',
  '{"ts":"2026-11-22T04:09:28","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795320568.6,"account":"claude-virev7@slack.green","slot_at":1795320840,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:28","event":"wait","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","account":"claude-virev7@slack.green","slot_at":"2026-11-22T04:14:00","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T04:09:28","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795320568.8,"account":"claude-virev7@slack.green","slot_at":1795320840,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:09:28","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T04:14:00"}',
  '{"ts":"2026-11-22T04:14:00","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320840.5,"account":"sieun@virev.ai","slot_at":1795323600,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:14:00","event":"wait","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","account":"sieun@virev.ai","slot_at":"2026-11-22T05:00:00","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T04:14:01","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320841.1,"account":"sieun@virev.ai","slot_at":1795323600,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:14:01","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320841.5,"account":"sieun@virev.ai","slot_at":1795323600,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:14:01","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:20:00","next":null,"retry_at":"2026-11-22T05:00:01"}',
  '{"ts":"2026-11-22T04:14:02","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795320842.0,"account":"sieun@virev.ai","slot_at":1795323600,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T04:14:02","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:00:01"}',
  '{"ts":"2026-11-22T04:17:24","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321044.2,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:17:24","event":"wait","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","account":"sieun@virev.ai","slot_at":"2026-11-22T05:02:00","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T04:17:24","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321044.6,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:17:24","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:02:00"}',
  '{"ts":"2026-11-22T04:17:25","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321046.0,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:17:26","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321046.2,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:17:26","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:02:00"}',
  '{"ts":"2026-11-22T04:28:16","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321696.0,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:28:16","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795321696.3,"account":"sieun@virev.ai","slot_at":1795323720,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:28:16","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:02:00"}',
  '{"ts":"2026-11-22T04:42:06","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795322526.2,"account":"claude-virev11@slack.green","slot_at":1795323661,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:42:06","event":"wait","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","account":"claude-virev11@slack.green","slot_at":"2026-11-22T05:01:01","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T04:42:06","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795322526.7,"account":"claude-virev11@slack.green","slot_at":1795323661,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:42:06","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:01:02"}',
  booked(cells),
  '{"ts":"2026-11-22T04:43:57","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795322637.2,"account":"claude3@slack.green","slot_at":1795322640,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:43:57","event":"parked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795322637.6,"account":"claude3@slack.green","slot_at":1795322640,"since":1795320568.6,"priority":"high"}',
  '{"ts":"2026-11-22T04:43:57","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T04:44:00"}',
  '{"ts":"2026-11-22T04:44:00","event":"unparked","provider":"anthropic","session":"01a10810-34b5-710f-88fe-3d369f89a8c9","at":1795322640.1,"account":"claude3@slack.green"}',
  '{"ts":"2026-11-22T04:44:00","event":"vend","provider":"anthropic","account":"claude3@slack.green","source":"store","reason":"switch","previous":"claude-virev1@slack.green","session":"01a10810-34b5-710f-88fe-3d369f89a8c9"}',
  '{"ts":"2026-11-22T05:00:02","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323602.1,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:02","event":"wait","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","account":"claude3@slack.green","slot_at":"2026-11-22T14:00:30","priority":"high","vend":"claude-virev1@slack.green","left":"limited"}',
  '{"ts":"2026-11-22T05:00:05","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323605.5,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:06","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323606.1,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:06","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323606.6,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:06","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:20:00","next":null,"retry_at":"2026-11-22T05:00:30"}',
  '{"ts":"2026-11-22T05:00:07","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323607.0,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:07","event":"limited","provider":"anthropic","account":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","until":"2026-11-22T08:19:59","next":null,"retry_at":"2026-11-22T05:00:30"}',
  '{"ts":"2026-11-22T05:00:08","event":"parked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323608.1,"account":"claude3@slack.green","slot_at":1795323630,"since":1795320552.2,"priority":"high"}',
  '{"ts":"2026-11-22T05:00:30","event":"unparked","provider":"anthropic","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908","at":1795323630.5,"account":"claude3@slack.green"}',
  '{"ts":"2026-11-22T05:00:30","event":"vend","provider":"anthropic","account":"claude3@slack.green","source":"store","reason":"switch","previous":"claude-virev1@slack.green","session":"01a0cc38-4679-76da-8bbc-c5d5cb779908"}',
];
const read = (lines: string[]) => {
  const smooth = readSmoothness(lines, new Set(), FROM, RUN);
  return { park: smooth.overtaken.find(entry => entry.session === MAC), metrics: measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth }).metrics };
};

test("a tree that slept past the cell a booked line gave it counts that time as its own wait", () => {
  const { park, metrics } = read(pool(true));
  assert.deepEqual(bare(park), { session: MAC, minutes: 0.5, asleep: 16 });
  assert.equal(metrics.parked_overtaken_over_10min, 0);
  assert.equal(metrics.queue_holds_30, 0);
});

test("without the booked cell on the line the same park reads as passed, as d7 read it at 05:07Z", () => {
  const { park, metrics } = read(pool(false));
  assert.equal(park?.minutes, 16.5);
  assert.equal(metrics.queue_holds_30, 1);
});

test("a tree that asked at its booked cell and was refused is still passed", () => {
  const refused = JSON.stringify({ ts: "2026-11-22T04:43:48", event: "parked", provider: "anthropic", session: MAC, at: 1795322628, account: "sieun@virev.ai",
    slot_at: 1795323600, since: 1795320552.2, priority: "high" });
  const lines = pool(true);
  lines.splice(lines.indexOf(booked(true)) + 1, 0, refused);
  assert.equal(read(lines).park?.minutes, 16.5);
});

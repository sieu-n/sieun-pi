import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { dutyQueueKey } from "../src/chat-turn-queue.ts";
import { endState } from "../src/checkin-end-state.ts";
import { stepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * Crawler VP at 10-15 21:13Z: the arbitrary limits duty (d3) and the GeoNode duty (d2) had named their fix jobs on p504, p505, p506 and p512,
 * and each fix job's create waited in pi-pool's queue under its duty's fix key (duty:<chat>:d3-fix, duty:<chat>:d2-fix) before it would ask
 * the fleet budget. The steps had a job and no session, so the check-in read them as stuck, though each goes on once the queue admits the key.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NOW = Date.parse("2026-10-15T21:13:00Z");
const self = new Set([CHAT, "Crawler VP"]);
const wait = "the Mac's fleet budget has room; the check-in then starts job crawler duty fixes (brief ready: p526, then p401, then the limits duty)";
const step = (id: string, extra: Partial<PlanItem>): PlanItem => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });
const items = [
  step("p504", { job: "fix arbitrary limits Crawler VP 06:12", duty: "d3/new_unbacked_limits", waitFor: wait }),
  step("p512", { job: "fix geonode proxy use Crawler VP 06:12", duty: "d2/working_exits_dropped",
    waitFor: "land 38 p7 (with 62caf9231e, the read cap removal) reaches prod, then the GeoNode duty re-reads working_exits_dropped" }),
  step("p157", { waitFor: wait }),
];
const queued = new Map([[dutyQueueKey(CHAT, "d3-fix"), { position: 3, total: 40 }], [dutyQueueKey(CHAT, "d2-fix"), { position: 4, total: 40 }],
  [dutyQueueKey("01a1164b-4a2d-742d-b27a-82f086ed0200", "d1-fix"), { position: 5, total: 40 }]]);
const view = (item: PlanItem) => stepView(item, NOW - 60_000, self, [], [], [], NOW);

test("end state: a duty's fix step whose job's create waits under the duty's fix key in pi-pool's queue is moving", () => {
  assert.deepEqual(items.map(item => endState(view(item), [], [], self, NOW, [], {}).state), ["event", "release", "event"], "no queue given");
  const states = items.map(item => endState(view(item), [], [], self, NOW, [], { queued }));
  assert.deepEqual(states.map(entry => entry.state), ["moving", "moving", "event"]);
  assert.equal(states[0]!.reason, "its fix job fix arbitrary limits Crawler VP 06:12's start waits for a working slot in pi-pool's queue");
});

test("another chat's fix key moves none of this chat's steps", () => {
  const other = new Map([[dutyQueueKey("01a1164b-4a2d-742d-b27a-82f086ed0200", "d3-fix"), { position: 1, total: 2 }]]);
  assert.equal(endState(view(items[0]!), [], [], self, NOW, [], { queued: other }).state, "event");
});

test("check-in precheck: the queued fix keys reach the stuck count", () => {
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-15T21:00:00.000Z", plan: [step("p146", { text: "Crawler ops", children: items })] };
  const run = checkInPrecheck(undefined, [], board, NOW, { self: [...self], rows: [], queued });
  assert.deepEqual(run.end.filter(entry => entry.state !== "moving").map(entry => entry.view.item.id), ["p157"]);
});

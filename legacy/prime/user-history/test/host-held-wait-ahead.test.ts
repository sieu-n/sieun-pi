// sep launch!! 11-08 10:25Z: the Mac read offline on Tailscale from 10:20Z, and p173 waited for "ops guy: staging Convex move serves about
// 12:30Z" with waitUntil 12:35Z, its job on the Mac asleep on a check by 12:35Z. Five sibling steps on the box read host_held, but p173's wait
// names another thread, so it read stuck (thread) and d9 read stuck_steps_all 1, though nothing was due for two hours. A held step whose wait
// is due later reads host; once its waitUntil or the clock its wait names passes with the box still offline, it reads by its wait (p125, 10-30).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const at = 1794133512359;
const p173: PlanItem = { id: "p173", text: "Staging pages load without error cards", status: "doing", job: "staging pages fail to load",
  note: "18 of 21 staging /app pages fail (walk 10:05-10:11Z): the staging app talks to the paused cloud Convex. convex-staging has data but no functions, and the URL flip 8301423418 is not landed. Our part: tags shows the raw error, welcome and dashboards hang, card copy is wrong. Done when a signed-in walk shows 0 error cards.",
  children: [], sessionId: "01a1ba9a-be5b-705c-a563-da77b2e33709",
  waitFor: "ops guy: staging Convex move serves about 12:30Z (21:30 KST); then job 'staging pages fail to load' re-walks to 0 cards",
  waitForAt: "2026-11-08T10:14:04.671Z", waitUntil: "2026-11-08T12:35:00.000Z" };
const rows = [{ id: SEP, name: "sep launch!!", host: "mac" }, { id: OPS, name: "ops guy (+observability)", host: "us-metal02" }] as unknown as SessionRow[];
const held = hostHolds([{ name: "mac", lastSeen: "2026-11-08T10:20:00Z" }]);

function p173At(now: number, item: PlanItem = p173) {
  const board = { v: 2, rev: 1, updatedAt: "2026-11-08T10:14:04.671Z", todos: [], plan: [{ id: "p2", text: "The 5180 app works for real", status: "doing", children: [item] }] } as unknown as ChatBoard;
  const facts: JobFact[] = [{ key: "child-p173", name: "staging pages fail to load", state: "working", sessionId: item.sessionId!,
    activityAt: Date.parse("2026-11-08T10:14:00Z"), wake: "board.wakes on run 42470776186 and on a check by 12:35Z" }];
  return checkInPrecheck(undefined, facts, board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held } }).end.find(entry => entry.view.item.id === "p173")!;
}

test("p173 at 10:25Z, held on the offline Mac with its wait due at 12:30Z and waitUntil 12:35Z, reads host and not thread", () => {
  const entry = p173At(at);
  assert.equal(entry.state, "host", entry.reason);
  assert.equal(entry.hold?.host, "mac");
});

test("p173 reads stuck (thread) once its waitUntil passed with the Mac still offline", () => {
  const entry = p173At(Date.parse("2026-11-08T12:40:00Z"));
  assert.equal(entry.state, "thread", entry.reason);
  assert.match(entry.reason, /another thread.*runs on mac, offline on Tailscale/);
});

test("a held step with a waitUntil ahead reads stuck (thread) once the clock its wait names passed", () => {
  const entry = p173At(Date.parse("2026-11-08T12:40:00Z"), { ...p173, waitUntil: "2026-11-08T14:00:00.000Z" });
  assert.equal(entry.state, "thread", entry.reason);
});

test("the p125 shape, a held wait on another thread with no waitUntil, still reads stuck (thread)", () => {
  const { waitUntil: _, ...open } = p173;
  const entry = p173At(at + 5 * MIN, { ...open, waitFor: "ops guy: the staging Convex move; then job 'staging pages fail to load' re-walks to 0 cards" });
  assert.equal(entry.state, "thread", entry.reason);
});

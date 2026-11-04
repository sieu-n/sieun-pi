// Guards d7's 20:50Z minute on 11-03: 16 s after a chat restart a catalog projection filtered all 252 pending wakes once for every agent of
// every chat (withWaits, treeWakes), held the event loop 632 ms in one task, and d7 read the chat's event loop stalled 1.3 s. On 11-04 the
// projection still walked each of the live chat's 3,065 agents' trees down, twice, for the wakes and the pi-pool places below it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queuedBelowIndex, withPoolBelow, withWaits } from "../src/chat-agents.ts";
import type { ChatAgent } from "../src/shared/types.ts";
import { treeWakeIndex, treeWakes, type Wake } from "../src/wakes.ts";

const agent = (index: number): ChatAgent => ({ key: `thread:s${index}`, sessionId: `s${index}`, name: `job ${index}`, job: `job ${index}`, sender: `job ${index}`,
  link: "subagent", state: "idle", steps: [] });
const counted = <T>(items: T[]): { items: readonly T[]; reads: () => number } => {
  let reads = 0;
  const items_ = new Proxy(items, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  return { items: items_, reads: () => reads };
};

test("withWaits reads each pending wake about once however many agents it marks", () => {
  const agents = Array.from({ length: 2000 }, (_, index) => agent(index));
  const above = (session: string): string | undefined => session === "s7-sub" ? "s7" : undefined;
  const wakes = counted<Wake>(Array.from({ length: 250 }, (_, index) =>
    ({ session: index === 0 ? "s7-sub" : `elsewhere-${index}`, on: { kind: "time", at: Date.parse("2026-11-03T21:00:00Z") + index * 60_000 }, note: "", since: 0 })));
  const marked = withWaits(agents, treeWakeIndex(wakes.items, above));
  assert.deepEqual(marked.filter(each => each.state === "working").map(each => [each.sessionId, each.wait]), [["s7", "waits for 21:00Z"]]);
  assert.ok(wakes.reads() < 3 * 250, `${wakes.reads()} wake reads for 2000 agents and 250 wakes`);
});

test("the wakes and pi-pool places below 2,000 agents with 20 subagents each are found walking up, never down an agent's tree", () => {
  const agents = Array.from({ length: 2000 }, (_, index) => agent(index));
  const parent = new Map<string, string>();
  for (let index = 0; index < 2000; index++) for (let kid = 0; kid < 20; kid++) parent.set(`s${index}-k${kid}`, `s${index}`);
  let ups = 0;
  const above = (session: string): string | undefined => { ups++; return parent.get(session); };
  const wakes: Wake[] = [{ session: "s3-k5", on: { kind: "time", at: Date.parse("2026-11-04T09:00:00Z") }, note: "", since: 0 }];
  const queued = new Map([["s9-k1", { position: 4, total: 30, since: 0 }], ["s9-k2", { position: 2, total: 30, since: 0 }]]);
  const marked = withPoolBelow(withWaits(agents, treeWakeIndex(wakes, above)), queuedBelowIndex(queued, above));
  assert.deepEqual(marked.filter(each => each.state === "working").map(each => [each.sessionId, each.wait]),
    [["s3", "waits for 09:00Z"], ["s9", "waits on a subagent queued 2 of 30 for a working slot"]]);
  assert.ok(ups <= 10, `${ups} parent reads for 3 waiting sessions under 2,000 agents of 21 sessions each`);
});

test("the wake index keeps the wakes of a tree in their list order, as treeWakes does", () => {
  const wake = (session: string, at: number): Wake => ({ session, on: { kind: "time", at }, note: "", since: 0 });
  const wakes = [wake("b", 3), wake("a", 1), wake("x", 9), wake("b", 2)];
  const below = (session: string): string[] => session === "a" ? ["b"] : [];
  const above = (session: string): string | undefined => session === "b" ? "a" : undefined;
  assert.deepEqual(treeWakes("a", below, wakes), [wakes[0], wakes[1], wakes[3]]);
  assert.deepEqual(treeWakes("x", below, wakes), [wakes[2]]);
  assert.deepEqual(treeWakes("none", below, wakes), []);
  const index = treeWakeIndex(wakes, above);
  for (const session of ["a", "b", "x", "none"]) assert.deepEqual(index.get(session) ?? [], treeWakes(session, below, wakes), session);
});

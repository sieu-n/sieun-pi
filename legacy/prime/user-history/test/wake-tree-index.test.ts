// Guards d7's 20:50Z minute on 11-03: 16 s after a chat restart a catalog projection filtered all 252 pending wakes once for every agent of
// every chat (withWaits, treeWakes), held the event loop 632 ms in one task, and d7 read the chat's event loop stalled 1.3 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withWaits } from "../src/chat-agents.ts";
import type { ChatAgent } from "../src/shared/types.ts";
import { treeWakes, type Wake } from "../src/wakes.ts";

const agent = (index: number): ChatAgent => ({ key: `thread:s${index}`, sessionId: `s${index}`, name: `job ${index}`, job: `job ${index}`, sender: `job ${index}`,
  link: "subagent", state: "idle", steps: [] });
const counted = <T>(items: T[]): { items: readonly T[]; reads: () => number } => {
  let reads = 0;
  const items_ = new Proxy(items, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  return { items: items_, reads: () => reads };
};

test("withWaits reads each pending wake about once however many agents it marks", () => {
  const agents = Array.from({ length: 2000 }, (_, index) => agent(index));
  const below = (session: string): string[] => session === "s7" ? ["s7-sub"] : [];
  const wakes = counted<Wake>(Array.from({ length: 250 }, (_, index) =>
    ({ session: index === 0 ? "s7-sub" : `elsewhere-${index}`, on: { kind: "time", at: Date.parse("2026-11-03T21:00:00Z") + index * 60_000 }, note: "", since: 0 })));
  const marked = withWaits(agents, wakes.items, below);
  assert.deepEqual(marked.filter(each => each.state === "working").map(each => [each.sessionId, each.wait]), [["s7", "waits for 21:00Z"]]);
  assert.ok(wakes.reads() < 3 * 250, `${wakes.reads()} wake reads for 2000 agents and 250 wakes`);
});

test("treeWakes keeps the wakes of a tree in their list order", () => {
  const wake = (session: string, at: number): Wake => ({ session, on: { kind: "time", at }, note: "", since: 0 });
  const wakes = [wake("b", 3), wake("a", 1), wake("x", 9), wake("b", 2)];
  const below = (session: string): string[] => session === "a" ? ["b"] : [];
  assert.deepEqual(treeWakes("a", below, wakes), [wakes[0], wakes[1], wakes[3]]);
  assert.deepEqual(treeWakes("x", below, wakes), [wakes[2]]);
  assert.deepEqual(treeWakes("none", below, wakes), []);
});

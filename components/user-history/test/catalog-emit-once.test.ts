// Guards the 10-18 sessions feed: the chat service's main thread was about 95% busy, project() took half of it, and overlapping projections sent bursts of 4 identical lists within 140 ms.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { SessionsEvent } from "../src/shared/types.ts";

test("emits asked for during a projection share one projection after it, and each caller resolves after a frame built after its ask", async t => {
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", new ChatReadState("unused"), new ChatLabels("unused"), ids, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let projections = 0;
  const gates: (() => void)[] = [];
  t.mock.method(catalog, "event", async (): Promise<SessionsEvent> => {
    const index = ++projections;
    await new Promise<void>(resolve => gates.push(resolve));
    return { type: "sessions", sessions: [], tags: [], daemon: "down", error: `projection ${index}` };
  });
  const frames: string[] = [];
  (catalog as unknown as { listeners: Set<(event: SessionsEvent) => void> }).listeners.add(event => frames.push(event.error ?? ""));
  const first = catalog.notify();
  const later = [catalog.notify(), catalog.notify(), catalog.notify(), catalog.notify()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projections, 1);
  gates.shift()?.();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projections, 2, "four asks during the first projection share one more");
  gates.shift()?.();
  await Promise.all(later);
  assert.deepEqual(frames, ["projection 1", "projection 2"]);
});

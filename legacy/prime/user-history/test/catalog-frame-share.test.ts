// Guards 10-27 on us-metal02: with 6,900 rows a projection took 150 to 200 ms, roster updates came 5.5 times a second, frames went out at the
// 500 ms floor (114 a minute), projections held 41% of the busy main thread, and reads waited 1.4 to 4.2 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("frames under a steady stream of changes hold well under half the time in projections", async t => {
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", new ChatReadState("unused"), new ChatLabels("unused"), ids, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  catalog.emitGapMs = 100;
  const PROJECTION_MS = 200;
  let busy = 0, projections = 0;
  t.mock.method(catalog as unknown as { project: () => Promise<unknown> }, "project", async () => {
    projections++;
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, PROJECTION_MS));
    busy += Date.now() - start;
    return { rows: [], tags: [] };
  });
  (catalog as unknown as { lastError: string }).lastError = "Connection to the Prime Agent daemon closed.";
  (catalog as unknown as { listeners: Set<() => void> }).listeners.add(() => {});
  const RUN_MS = 4000;
  const from = Date.now();
  const asks: Promise<void>[] = [];
  // A roster change every 50 ms, as a busy daemon sends them.
  while (Date.now() - from < RUN_MS) { asks.push(catalog.notify()); await new Promise(resolve => setTimeout(resolve, 50)); }
  const span = Date.now() - from;
  await Promise.all(asks);
  const share = busy / span;
  assert.ok(share <= 0.4, `projections held ${Math.round(share * 100)}% of ${span} ms in ${projections} runs`);
  assert.ok(projections >= 3, `the frames kept coming: ${projections} runs`);
});

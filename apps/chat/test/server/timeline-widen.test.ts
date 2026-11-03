/**
 * A thread page reads back to the input that starts its oldest turn: a short turn takes one pi-host read, and a turn longer than one read
 * takes as many as it needs, with the same items either way.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/timeline-widen.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let host: FixtureHost;
let reads: { limit?: number; lean?: boolean }[] = [];
before(async () => {
  s = await start();
  host = s.host as FixtureHost;
  const entries = host.entries.bind(host);
  host.entries = async (thread, opts) => {
    reads.push({ limit: opts.limit, lean: (opts as { lean?: boolean }).lean });
    return entries(thread, opts);
  };
});
after(async () => {
  await s.close();
});

/** A thread of turns, each an input and `steps` tool calls with their results, oldest first. */
function seed(name: string, turns: number[]): string {
  const thread = host.addThread({ name, createdAt: 1 });
  let at = 1000;
  turns.forEach((steps, turn) => {
    host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: `ask ${turn}`, timestamp: at++ }] } as never);
    for (let step = 0; step < steps; step++) {
      host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: `c${turn}.${step}`, name: "bash", arguments: { command: `echo ${step}` } }], provider: "p", model: "m", timestamp: at++ }] } as never);
      host.append(thread, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${turn}.${step}`, toolName: "bash", content: [{ type: "text", text: `${step}` }], timestamp: at++ }] } as never);
    }
    host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: `done ${turn}` }], provider: "p", model: "m", timestamp: at++ }] } as never);
  });
  return thread.row.id;
}

const shape = (page: TimelinePage) => page.items.map(i => (i.kind === "turn" ? `${i.id}:${(i as Extract<Item, { kind: "turn" }>).steps.length}` : i.id));

test("a page whose oldest turn starts within the widening takes one lean read", async () => {
  const id = seed("short turns", [5, 5, 5, 5, 5, 5]);
  reads = [];
  const page = await s.get<TimelinePage>(`/api/c/${id}/items?limit=10`);
  assert.equal(page.items[0]!.kind, "message", "the page starts at an input");
  assert.ok(page.older);
  const pageReads = reads.filter(r => r.limit !== 1);
  assert.deepEqual(pageReads, [{ limit: 110, lean: true }]);
});

test("a turn longer than one read is read whole, oldest first, and the older page continues before it", async () => {
  const id = seed("long turn", [3, 260, 2]);
  reads = [];
  const page = await s.get<TimelinePage>(`/api/c/${id}/items?limit=10`);
  assert.deepEqual(shape(page).slice(0, 2), ["e10", "t10:260"]);
  assert.equal(reads.filter(r => r.limit !== 1).length, 6, "one widened read, then 100-entry reads back to the long turn's input");
  assert.ok(reads.every(r => r.lean));
  const older = await s.get<TimelinePage>(`/api/c/${id}/items?before=${page.older}&limit=10`);
  assert.deepEqual(shape(older), ["e2", "t2:3"]);
  assert.equal(older.older, undefined);
});

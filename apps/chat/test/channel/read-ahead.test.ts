import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { RunStatus } from "../../web/src/lib/api/types.ts";

(globalThis as { document?: unknown }).document = { visibilityState: "visible", addEventListener: () => undefined };
const { ReadAhead, READ_AGAIN_MS } = await import("../../web/src/lib/api/read-ahead.ts");

const settle = () => new Promise(resolve => setImmediate(resolve));

/** A queue whose reads end at once, on a page clock the test moves, and the page clock of each read by id. */
function queue() {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const read: string[] = [];
  const at: number[] = [];
  const ahead = new ReadAhead(async wanted => {
    read.push(wanted.id);
    at.push(Date.now());
  });
  const want = async (list: { id: string; at: number; status: RunStatus }[]) => {
    ahead.want(list);
    await settle();
  };
  const tick = async (ms: number) => {
    mock.timers.tick(ms);
    await settle();
  };
  return { read, at, want, tick };
}

test("a run that flips between working and sleeping is read once, and again once it is idle", async (t) => {
  t.after(() => mock.timers.reset());
  const { read, want, tick } = queue();
  await want([{ id: "ag_fable-auditor", at: 1, status: "working" }]);
  // Each model call waits for a slot or an account, which pi-host reports as sleeping, and each flip moves the agent's updatedAt.
  for (let at = 2; at < 40; at += 1) {
    await want([{ id: "ag_fable-auditor", at, status: at % 2 ? "working" : "sleeping" }]);
    await tick(2_000);
  }
  assert.deepEqual(read, ["ag_fable-auditor"]);
  await want([{ id: "ag_fable-auditor", at: 41, status: "idle" }]);
  await tick(READ_AGAIN_MS);
  await want([{ id: "ag_fable-auditor", at: 41, status: "idle" }]);
  assert.deepEqual(read, ["ag_fable-auditor", "ag_fable-auditor"]);
});

test("an agent at rest whose jobs step every 2 s is read at most twice in 3 min, the last change included", async (t) => {
  t.after(() => mock.timers.reset());
  const { at, want, tick } = queue();
  let updated = 1;
  for (let step = 0; step < 90; step += 1) {
    await want([{ id: "ag_seo", at: updated, status: "idle" }]);
    updated += 1;
    await tick(2_000);
  }
  const windows = at.map(start => at.filter(when => when >= start && when < start + 180_000).length);
  assert.ok(Math.max(...windows) <= 2, `reads at ${at.join(", ")} ms`);
  // The last change came at 178 s with no event after it, and the queue still read it once `READ_AGAIN_MS` passed, then no more.
  await tick(READ_AGAIN_MS);
  assert.ok(at.at(-1)! >= 178_000, `reads at ${at.join(", ")} ms`);
  const reads = at.length;
  await tick(READ_AGAIN_MS);
  assert.equal(at.length, reads);
});

test("reads of one item stay 2 in 3 min even when the timing log's 10 s batches pull them closer", async (t) => {
  t.after(() => mock.timers.reset());
  const { at, want, tick } = queue();
  let updated = 1;
  for (let step = 0; step < 150; step += 1) {
    await want([{ id: "ag_seo", at: updated, status: "idle" }]);
    updated += 1;
    await tick(2_000);
  }
  // A line reaches the log up to 10 s after its read, so the log sees the reads as if 10 s closer.
  const windows = at.map(start => at.filter(when => when >= start && when <= start + 180_000 + 10_000).length);
  assert.ok(Math.max(...windows) <= 2, `reads at ${at.join(", ")} ms`);
});

test("an idle or failed one is read again only when its activity is newer than the last read", async (t) => {
  t.after(() => mock.timers.reset());
  const { read, want, tick } = queue();
  await want([{ id: "a", at: 5, status: "idle" }, { id: "b", at: 5, status: "failed" }]);
  await tick(READ_AGAIN_MS);
  await want([{ id: "a", at: 5, status: "idle" }, { id: "b", at: 5, status: "failed" }]);
  await want([{ id: "a", at: 6, status: "idle" }, { id: "b", at: 6, status: "failed" }]);
  assert.deepEqual(read, ["a", "b", "a", "b"]);
});

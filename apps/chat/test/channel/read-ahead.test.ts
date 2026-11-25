import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunStatus } from "../../web/src/lib/api/types.ts";

(globalThis as { document?: unknown }).document = { visibilityState: "visible", addEventListener: () => undefined };
const { ReadAhead } = await import("../../web/src/lib/api/read-ahead.ts");

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A queue whose reads end at once, and the ids it read, in order. */
function queue() {
  const read: string[] = [];
  const ahead = new ReadAhead(async wanted => void read.push(wanted.id));
  const want = async (list: { id: string; at: number; status: RunStatus }[]) => {
    ahead.want(list);
    await settle();
  };
  return { read, want };
}

test("a run that flips between working and sleeping is read once, and again once it is idle", async () => {
  const { read, want } = queue();
  await want([{ id: "ag_fable-auditor", at: 1, status: "working" }]);
  // Each model call waits for a slot or an account, which pi-host reports as sleeping, and each flip moves the agent's updatedAt.
  for (let at = 2; at < 40; at += 1) await want([{ id: "ag_fable-auditor", at, status: at % 2 ? "working" : "sleeping" }]);
  assert.deepEqual(read, ["ag_fable-auditor"]);
  await want([{ id: "ag_fable-auditor", at: 41, status: "idle" }]);
  await want([{ id: "ag_fable-auditor", at: 41, status: "idle" }]);
  assert.deepEqual(read, ["ag_fable-auditor", "ag_fable-auditor"]);
});

test("an idle or failed one is read again only when its activity is newer than the last read", async () => {
  const { read, want } = queue();
  await want([{ id: "a", at: 5, status: "idle" }, { id: "b", at: 5, status: "failed" }]);
  await want([{ id: "a", at: 5, status: "idle" }, { id: "b", at: 5, status: "failed" }]);
  await want([{ id: "a", at: 6, status: "idle" }, { id: "b", at: 6, status: "failed" }]);
  assert.deepEqual(read, ["a", "b", "a", "b"]);
});

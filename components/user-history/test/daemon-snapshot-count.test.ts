import assert from "node:assert/strict";
import test from "node:test";
import { DaemonAgentConnection } from "prime-agent";
import "../src/daemon-snapshot-count.ts";

/** Completes an attach snapshot of two chunks, of which `arrived` came, that the daemon announced as `announced` messages. */
async function complete(announced: number, arrived: number): Promise<{ messages?: unknown[]; error?: Error }> {
  const result: { messages?: unknown[]; error?: Error } = {};
  const chunks = new Map([[0, [{ role: "user" }, { role: "custom" }]], [1, [{ role: "assistant" }]]].slice(0, arrived) as [number, unknown[]][]);
  const assembly = { begin: { purpose: "attach", messageCount: announced, snapshot: { state: {} } }, chunks,
    resolve: (snapshot: { messages: unknown[] }) => { result.messages = snapshot.messages; }, reject: (error: Error) => { result.error = error; } };
  const connection = Object.assign(Object.create(DaemonAgentConnection.prototype), { snapshotAssemblies: new Map([["s1", assembly]]) });
  await connection.completeSnapshotAssembly({ snapshotId: "s1", chunkCount: 2, lastEventSequence: 1 });
  return result;
}

test("a streamed snapshot opens whether the daemon counts file rows (0.10.0) or the transcript (0.9.8); a lost chunk still fails", async () => {
  assert.equal((await complete(2, 2)).messages?.length, 3);
  assert.equal((await complete(3, 2)).messages?.length, 3);
  assert.match((await complete(3, 1)).error?.message ?? "", /ended with 1 of 2 chunks/);
});

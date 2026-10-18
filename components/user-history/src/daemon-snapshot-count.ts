import { DaemonAgentConnection } from "prime-agent";

type Assembly = { begin?: { messageCount: number }; chunks: Map<number, readonly unknown[]> };
type Internals = { snapshotAssemblies: Map<string, Assembly>; completeSnapshotAssembly(message: { snapshotId: string; chunkCount: number }): Promise<void> };

/**
 * The Rust daemon (0.10.0) announces a streamed snapshot's size as the session file's message-row count. The transcript it streams also holds
 * custom messages and compaction summaries and leaves out compacted turns, so the 0.9.8 client rejected nearly every live attach
 * ("Snapshot ... contained 77 of 75 messages"). The chunk count still catches a lost chunk; this module counts the messages that arrived
 * instead. Remove it once the daemon announces the transcript length again.
 */
const prototype = DaemonAgentConnection.prototype as unknown as Internals;
const complete = prototype.completeSnapshotAssembly;
prototype.completeSnapshotAssembly = function (this: Internals, message) {
  const assembly = this.snapshotAssemblies.get(message.snapshotId);
  if (assembly?.begin && assembly.chunks.size === message.chunkCount) {
    let arrived = 0;
    for (const chunk of assembly.chunks.values()) arrived += chunk.length;
    assembly.begin = { ...assembly.begin, messageCount: arrived };
  }
  return complete.call(this, message);
};

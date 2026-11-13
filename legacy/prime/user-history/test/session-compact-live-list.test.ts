// Guards 11-13: a herd of full lists (`list` with `all`, 97 MB and about 13 CPU-s each on the supervisor's one thread) held every other
// daemon call up to 657 s. The compaction's busy check asks every 2 s while a session works, and only a session a worker holds can write,
// so it reads the live list.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { busy } from "../scripts/session-compact.ts";

test("the busy check reads the daemon's live list, not every saved session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-compact-live-"));
  const socket = join(dir, "daemon.sock");
  const seen: unknown[] = [];
  const rows = [{ sessionFile: "/s/working.jsonl", lifecycle: "live", activity: "working", isStreaming: true }];
  const server = createServer(connection => {
    connection.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } }) + "\n");
    let buffer = "";
    connection.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const envelope = JSON.parse(buffer.slice(0, end)) as { id: string; command: unknown };
      seen.push(envelope.command);
      connection.end(JSON.stringify({ type: "response", id: envelope.id, success: true, data: { sessions: rows } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    assert.equal(await busy(socket, "/s/working.jsonl"), "activity working, streaming");
    assert.equal(await busy(socket, "/s/saved.jsonl"), undefined);
    assert.deepEqual(seen, [{ type: "list" }, { type: "list" }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

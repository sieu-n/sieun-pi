// Replays the 10-21 08:36:06Z open of job 01a15019 from its wake check: the daemon answered its attach "Active session 50c53297d128 closed
// during attach", since the idle unload's kill had just closed the session, and the open failed ("job 01a15019: wake: Active session ...").
// The session is no longer live, so the open now reads it saved.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a15019-901b-7648-95af-5f16d0d16a72";
const ACTIVE = "50c53297d128";

test("an open whose attach meets the session's close reads the session saved instead of failing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "closed-attach-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-21T08:30:00.000Z", cwd: dir }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-21T08:30:01.000Z", message: { role: "user", content: [{ type: "text", text: "alert crawler-lane-held-low-prod" }], timestamp: 1 } })].join("\n") + "\n");
  const socketPath = join(dir, "daemon.sock");
  const daemon = createServer(socket => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30, serverCapabilities: [], appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        if (type === "attach") { socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: false, error: `Active session ${ACTIVE} closed during attach` }) + "\n"); continue; }
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data: type === "get_messages" ? { messages: [] } : {} }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(socketPath, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); daemon.close(); });

  assert.equal(hub.attaching(ID), false);
  const opening = hub.open(ID, true);
  assert.equal(hub.attaching(ID), true, "the open is under way");
  const thread = await opening;
  assert.equal(thread.live, null, "the closed session is not attached");
  assert.equal(thread.state.kind, "saved");
  assert.equal(hub.attaching(ID), false, "the open ended");
});

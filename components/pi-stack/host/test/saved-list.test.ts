import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostClient } from "../src/client.ts";
import { PiHost } from "../src/host.ts";
import type { SavedSessionSummary, SessionSummary } from "../src/protocol.ts";
import { listen } from "../src/server.ts";
import echo from "./fixtures/echo.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

const options = (root: string) => ({
  agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"), extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" },
  resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
});

test("list with all names a session saved before a host restart as Prime does, with no activeSessionId, and a create by its path reopens it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-saved-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let host = new PiHost(options(root));
  let server = await listen(host, join(root, "a.sock"));
  let client = await HostClient.connect(join(root, "a.sock"));
  let file: string | undefined;
  try {
    const summary = await client.call<SessionSummary>({ type: "create", lifecycle: "resident", name: "kept" } as never);
    await client.call({ type: "attach", activeSessionId: summary.activeSessionId, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] });
    await client.call({ type: "prompt", activeSessionId: summary.activeSessionId, message: "remember me" });
    await client.waitForAgentEnd(summary.activeSessionId);
    file = host.sessions.get(summary.activeSessionId)!.session.sessionFile;
  } finally {
    client.close();
    await host.shutdown();
    server.close();
  }
  host = new PiHost(options(root));
  server = await listen(host, join(root, "b.sock"));
  client = await HostClient.connect(join(root, "b.sock"));
  try {
    const { sessions } = await client.call<{ sessions: (SessionSummary | SavedSessionSummary)[] }>({ type: "list", all: true } as never);
    const row = sessions.find(entry => entry.sessionFile === file) as SavedSessionSummary & { activeSessionId?: string };
    assert.ok(row, JSON.stringify(sessions));
    assert.equal(row.activeSessionId, undefined);
    assert.equal(row.lifecycle, "archived");
    assert.equal(row.sessionName, "kept");
    assert.match(row.firstMessage, /remember me/);
    const { sessions: live } = await client.call<{ sessions: SessionSummary[] }>({ type: "list" } as never);
    assert.equal(live.length, 0);
    const reopened = await client.call<SessionSummary>({ type: "create", sessionPath: file } as never);
    assert.equal(reopened.sessionId, row.sessionId);
  } finally {
    client.close();
    await host.shutdown();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

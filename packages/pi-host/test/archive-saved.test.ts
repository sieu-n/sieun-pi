import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostClient } from "../src/client.ts";
import { PiHost } from "../src/host.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { listen } from "../src/server.ts";
import echo from "./fixtures/echo.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

test("archive_saved_session refuses a loaded session, then cancels a saved tree's jobs and appends owner_archive without opening it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-archive-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const host = new PiHost({
    agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"), extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" },
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
  });
  const server = await listen(host, join(root, "host.sock"));
  const client = await HostClient.connect(join(root, "host.sock"));
  try {
    assert.ok(client.hello.serverCapabilities.includes("saved_session_archive"));
    const summary = await client.call<SessionSummary>({ type: "create", lifecycle: "resident" } as never);
    const id = summary.activeSessionId;
    await client.call({ type: "attach", activeSessionId: id, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] });
    await client.call({ type: "prompt", activeSessionId: id, message: "keep me" });
    await client.waitForAgentEnd(id);
    const file = host.sessions.get(id)!.session.sessionFile!;
    await assert.rejects(client.call({ type: "archive_saved_session", sessionPath: file } as never), /Cannot archive a resident session/);
    const job = host.scheduler.addCron(id, "0 9 * * *", "wake up");
    // An idle unload keeps the session's jobs (Prime close-keeps-jobs), which is what leaves a saved session with jobs to cancel.
    await host.kill(id, "idle_unload");
    const answer = await client.call<{ sessionId: string; cancelledJobs: number }>({ type: "archive_saved_session", sessionPath: file } as never);
    assert.equal(answer.sessionId, id);
    assert.equal(answer.cancelledJobs, 1);
    assert.equal(host.scheduler.list({ includeInactive: true }).find(item => item.id === job.id)?.status, "cancelled");
    assert.equal(host.sessions.has(id), false, "the archive never opens the session");
    const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
    assert.equal(last.type, "session_state");
    assert.deepEqual(last.state, { status: "archived", reason: "owner_archive" });
    const reopened = await client.call<SessionSummary>({ type: "create", sessionPath: file } as never);
    assert.equal(reopened.sessionId, id, "Pi opens the file with the archive line");
  } finally {
    client.close();
    await host.shutdown();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

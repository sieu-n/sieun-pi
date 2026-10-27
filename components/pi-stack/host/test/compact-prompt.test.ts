import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a /compact prompt compacts the session, as Prime ran it from prompt text, and the model never sees the text", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-compact-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const host = new PiHost({
    agentDir, sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"), extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" },
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
  });
  const server = await listen(host, join(root, "host.sock"));
  const client = await HostClient.connect(join(root, "host.sock"));
  try {
    const summary = await client.call<SessionSummary>({ type: "create", lifecycle: "resident" } as never);
    const id = summary.activeSessionId;
    await client.call({ type: "attach", activeSessionId: id, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] });
    for (const text of ["one", "two"]) {
      const seq = host.sessions.get(id)!.sequence;
      await client.call({ type: "prompt", activeSessionId: id, message: text });
      await client.waitForAgentEnd(id, seq);
    }
    const ended = client.waitFor(line => line.type === "session_event" && (line as { event: { type: string } }).event.type === "compaction_end");
    const answer = await client.call<{ disposition: string }>({ type: "prompt", activeSessionId: id, message: "/compact keep the numbers", streamingBehavior: "followUp", queueIfBusy: true });
    assert.equal(answer.disposition, "handled");
    const end = await ended as { event: { aborted?: boolean; errorMessage?: string; result?: unknown } };
    assert.equal(end.event.errorMessage, undefined, JSON.stringify(end.event));
    const entries = host.sessions.get(id)!.session.sessionManager.getEntries();
    assert.equal(entries.filter(entry => entry.type === "compaction").length, 1);
    const texts = entries.flatMap(entry => entry.type === "message" ? [JSON.stringify(entry.message)] : []);
    assert.ok(!texts.some(text => text.includes("/compact")), texts.join("\n"));
  } finally {
    client.close();
    await host.shutdown();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

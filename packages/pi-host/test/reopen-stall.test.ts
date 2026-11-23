import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HostClient } from "../src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.PI_HOST_MAIN ?? join(here, "../src/main.ts");
/** The probe bound of the pi-host stall work. A list call waited 27 ms on an idle box and 85 ms at load average 140 on 80 cores (11-23). */
const BOUND_MS = 300;

/**
 * An extension of 40 TypeScript files of 12 KB. Through jiti, the old open path, Babel takes about 4 s on it, near the 3.0 s it took on
 * pi-host's seven extensions (135 files) in a cold first open on 11-23.
 */
function writeExtension(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const files = 40;
  for (let i = 0; i < files; i++) {
    let body = `export interface Row${i}<T> { id: string; value: T; tags: readonly string[] }\n`;
    for (let j = 0; body.length < 12_000; j++) {
      body += `export class Store${i}_${j}<T extends { id: string }> {\n  private readonly rows = new Map<string, T>();\n`
        + `  put(row: T): this { this.rows.set(row.id, row); return this; }\n`
        + `  find(predicate: (row: T) => boolean): T | undefined { for (const row of this.rows.values()) if (predicate(row)) return row; return undefined; }\n`
        + `  get size(): number { return this.rows.size; }\n}\n`
        + `export const pick${i}_${j} = <K extends string>(keys: readonly K[], row: Record<K, unknown>): Partial<Record<K, unknown>> => Object.fromEntries(keys.map(key => [key, row[key]])) as Partial<Record<K, unknown>>;\n`;
    }
    writeFileSync(join(dir, `m${i}.ts`), body);
  }
  const imports = Array.from({ length: files }, (_, i) => `import { Store${i}_0 } from "./m${i}.ts";`).join("\n");
  const index = join(dir, "index.ts");
  writeFileSync(index, `${imports}\nconst stores = [${Array.from({ length: files }, (_, i) => `Store${i}_0`).join(", ")}];\n`
    + `export default function (pi: { registerCommand(name: string, options: { description: string; handler: () => Promise<void> }): void }): void {\n`
    + `  pi.registerCommand("stores", { description: \`\${stores.length} stores\`, handler: async () => {} });\n}\n`);
  return index;
}

/** A session file as long as 01a17e5d on 11-23: 2,360 messages and about 3.1 MB. */
function writeSession(dir: string, cwd: string): { id: string; file: string } {
  const manager = SessionManager.create(cwd, dir);
  const text = (n: number, seed: number) => Array.from({ length: Math.ceil(n / 6) }, (_, i) => ["board", "step", "check", "job", "wake", "note"][(seed + i) % 6]).join(" ").slice(0, n);
  manager.appendModelChange("echo", "m");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let messages = 0;
  for (let turn = 0; messages < 2360; turn++) {
    manager.appendCustomMessageEntry("heartbeat", `[heartbeat] Look at the board status. ${text(200, turn)}`, true, { turn });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: text(300, turn) }], timestamp: turn });
    messages++;
    for (let call = 0; call < 2; call++) {
      const id = `toolu_${turn}_${call}`;
      manager.appendMessage({
        role: "assistant", content: [{ type: "thinking", thinking: text(250, turn + call), thinkingSignature: "s".repeat(120) }, { type: "toolCall", id, name: "ipython", arguments: { code: text(250, call) } }],
        api: "echo-api", provider: "echo", model: "m", stopReason: "toolUse", timestamp: turn, usage,
      });
      manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "ipython", content: [{ type: "text", text: text(900, turn + call) }], isError: false, timestamp: turn });
      messages += 2;
      manager.appendCustomEntry("rlm-state", { turn, call, cells: text(150, call) });
    }
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: text(400, turn) }], api: "echo-api", provider: "echo", model: "m", stopReason: "stop", timestamp: turn, usage });
    messages++;
    for (const kind of ["harness-digest", "child_usage_attributed", "rlm-cell"]) manager.appendCustomEntry(kind, { turn, text: text(180, turn) });
  }
  return { id: manager.getSessionId(), file: manager.getSessionFile()! };
}

test("reopening a session as long as 01a17e5d, with a big extension, delays no command over 300 ms", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-reopen-"));
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const socket = join(root, "host.sock");
  const extension = writeExtension(join(root, "ext"));
  const saved = writeSession(join(root, "sessions"), ws);
  const child = spawn(process.execPath, ["--import", "tsx", MAIN, "--socket", socket, "--agent-dir", join(root, "agent"), "--session-dir", join(root, "sessions"),
    "--data-dir", join(root, "data"), "--cwd", ws, "--no-default-extensions", "--no-durable", "--extension", join(here, "fixtures/echo.ts"), "--extension", extension], {
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", chunk => { log += chunk; });
  let probe: HostClient | undefined;
  let opener: HostClient | undefined;
  try {
    for (let i = 0; i < 600 && !existsSync(socket); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(socket), `pi-host did not listen:\n${log}`);
    probe = await HostClient.connect(socket);
    opener = await HostClient.connect(socket);
    for (let i = 0; i < 20; i++) await probe.call({ type: "list" });

    const waits: number[] = [];
    let reopening = true;
    const probing = (async () => {
      while (reopening) {
        const start = performance.now();
        await probe!.call({ type: "list" });
        waits.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    const start = performance.now();
    await opener.call({ type: "get_state", activeSessionId: saved.id });
    const reopenMs = performance.now() - start;
    reopening = false;
    await probing;

    const longest = Math.max(...waits);
    process.stderr.write(`reopen ${Math.round(reopenMs)} ms, ${waits.length} probe calls, longest ${Math.round(longest)} ms\n`);
    assert.ok(waits.length > 0);
    assert.ok(longest <= BOUND_MS, `a list call waited ${Math.round(longest)} ms while the session reopened (bound ${BOUND_MS} ms, reopen ${Math.round(reopenMs)} ms)`);

    const { messages } = await opener.call<{ messages: AgentMessage[] }>({ type: "get_messages", activeSessionId: saved.id });
    assert.deepEqual(messages, SessionManager.open(saved.file).buildSessionContext().messages);
    const commands = await opener.call<{ commands: { name: string; description?: string }[] }>({ type: "get_commands", activeSessionId: saved.id });
    assert.equal(commands.commands.find(command => command.name === "stores")?.description, "40 stores", "the extension loaded into the reopened session");
  } finally {
    probe?.close();
    opener?.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

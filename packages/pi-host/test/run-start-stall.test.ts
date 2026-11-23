import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildDigest, buildQueryTerms } from "../../pi-harness/src/core/digest.ts";
import { mergeStates, readState } from "../../pi-harness/src/core/store.ts";
import { HostClient } from "../src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.PI_HOST_MAIN ?? join(here, "../src/main.ts");
const HARNESS = process.env.PI_HARNESS_EXTENSION ?? join(here, "../../pi-harness/src/pi/index.ts");
/** The probe bound of the pi-host stall work, as in reopen-stall.test.ts. */
const BOUND_MS = 300;

/** 400 made-up words of 6 to 9 letters, so the session's texts give 48 query terms that each match some of the store's entries. */
const WORDS = Array.from({ length: 400 }, (_, i) => {
  const letters = "abcdefghiklmnoprstuvwyz";
  let word = "";
  for (let n = i * 7919 + 13; word.length < 6 + (i % 4); n = Math.floor(n / letters.length) + i * 31 + word.length * 17) word += letters[n % letters.length];
  return word;
});
const text = (n: number, seed: number) => Array.from({ length: Math.ceil(n / 8) }, (_, i) => WORDS[(seed * 37 + i * 11) % WORDS.length]).join(" ").slice(0, n);

/** A global store as big as the live one on 11-23: 106 prompt notes and 750 memories, 1.5 MB, and 163 refinements. */
function writeStore(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const at = "2026-11-23T00:00:00.000Z";
  const entry = (kind: "prompt" | "memory", i: number) => ({
    id: `${kind}_${i}_${WORDS[i % WORDS.length]}`, kind, title: text(90, i + 1), content: text(1500, i * 3 + 2), path: `agent/${WORDS[(i * 5) % WORDS.length]}`,
    scope: "global", reference: {}, arguments: {}, metadata: {}, source: "test", created_at: at, updated_at: at, version: 1,
  });
  const entries = (kind: "prompt" | "memory", n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => entry(kind, i)).map(e => [e.id, e]));
  const refinements = Array.from({ length: 163 }, (_, i) => ({ id: `refine_${i}`, trigger: text(200, i), changes: [`update memory:memory_${i}`], outcome: text(200, i + 9), created_at: at }));
  writeFileSync(join(dir, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: entries("prompt", 106), memory: entries("memory", 750), skill: {}, subagent: {} }, refinements }, null, 2));
}

/** A session of 2,000 user and assistant text messages on the echo model. */
function writeSession(dir: string, cwd: string): { id: string; file: string } {
  const manager = SessionManager.create(cwd, dir);
  manager.appendModelChange("echo", "m");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let turn = 0; turn < 1000; turn++) {
    manager.appendMessage({ role: "user", content: [{ type: "text", text: text(400, turn) }], timestamp: turn });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: text(1200, turn + 500) }], api: "echo-api", provider: "echo", model: "m", stopReason: "stop", timestamp: turn, usage });
  }
  return { id: manager.getSessionId(), file: manager.getSessionFile()! };
}

const textOf = (message: AgentMessage) => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ") : "";
};

test("a run start in a long session with the live-sized harness store delays no command over 300 ms, and its digest is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-run-start-"));
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const socket = join(root, "host.sock");
  const store = join(root, "harness");
  writeStore(store);
  const saved = writeSession(join(root, "sessions"), ws);
  const child = spawn(process.execPath, ["--import", "tsx", MAIN, "--socket", socket, "--agent-dir", join(root, "agent"), "--session-dir", join(root, "sessions"),
    "--data-dir", join(root, "data"), "--cwd", ws, "--no-default-extensions", "--no-durable", "--extension", join(here, "fixtures/echo.ts"), "--extension", HARNESS], {
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", RLM_GLOBAL_HARNESS_STATE_DIR: store, PI_HARNESS_DIGEST_ROUTE: "message" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", chunk => { log += chunk; });
  let probe: HostClient | undefined;
  let sender: HostClient | undefined;
  try {
    for (let i = 0; i < 600 && !existsSync(socket); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(socket), `pi-host did not listen:\n${log}`);
    probe = await HostClient.connect(socket);
    sender = await HostClient.connect(socket);
    await sender.call({ type: "get_state", activeSessionId: saved.id });
    for (let i = 0; i < 20; i++) await probe.call({ type: "list" });

    const prompt = `Look at the board status. ${text(300, 77)}`;
    const before = SessionManager.open(saved.file).buildSessionContext().messages;
    const waits: number[] = [];
    let running = true;
    const probing = (async () => {
      while (running) {
        const start = performance.now();
        await probe!.call({ type: "list" });
        waits.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    const start = performance.now();
    await sender.call({ type: "prompt", activeSessionId: saved.id, message: prompt });
    await sender.call({ type: "wait_for_idle", activeSessionId: saved.id });
    const runMs = performance.now() - start;
    running = false;
    await probing;

    const longest = Math.max(...waits);
    process.stderr.write(`run ${Math.round(runMs)} ms, ${waits.length} probe calls, longest ${Math.round(longest)} ms\n`);
    assert.ok(waits.length > 0);
    assert.ok(longest <= BOUND_MS, `a list call waited ${Math.round(longest)} ms while the run started (bound ${BOUND_MS} ms, run ${Math.round(runMs)} ms)`);

    const { messages } = await sender.call<{ messages: AgentMessage[] }>({ type: "get_messages", activeSessionId: saved.id });
    const digests = messages.filter(m => m.role === "custom" && (m as { customType?: string }).customType === "harness_digest");
    assert.equal(digests.length, 1, "the run carried one digest message");
    const recent = [...before.filter(m => m.role === "user" || m.role === "assistant").map(textOf), prompt];
    const expected = buildDigest(mergeStates(readState(store, "global")), {
      includeIpythonExamples: false, includeShellExamples: true, includeRefineExamples: false, queryTerms: buildQueryTerms(undefined, recent),
    });
    assert.equal(buildQueryTerms(undefined, recent).size, 48);
    assert.equal((digests[0] as { details?: { digest?: string } }).details?.digest, expected);
  } finally {
    probe?.close();
    sender?.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AlertBridge } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { walkItems } from "../src/shared/chat-board.ts";
import type { PlanItem } from "../src/shared/types.ts";
import { HOOK_ALERT_NAME, HOOK_WINDOW_MS, tallyTail, TokenHookWatch, withHookAlert } from "../src/token-hook-watch.ts";

const HOOK = fileURLToPath(new URL("../../pi-pool/bin/pi-pool-token", import.meta.url));
const HARNESS = ALERT_ROUTES.find(route => route.chat === "AI harness developer environment VP")!.session;
const NOW = Date.parse("2026-10-16T08:50:00Z");
const PRIME_ERROR = `Failed to resolve API key for provider "anthropic" from shell command: ${HOOK} pi-pool: the token hook gave no token; the retry uses a new hook run.`;

const header = (id: string) => JSON.stringify({ type: "session", id, timestamp: new Date(NOW - 3_600_000).toISOString() });
const failed = (at: number, error = PRIME_ERROR) =>
  JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: error, content: [] } });
const answered = (at: number) =>
  JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "anthropic", stopReason: "stop", content: [{ type: "text", text: "done" }] } });

/** Runs the pool's token hook the way Prime runs a "!command" apiKey: a shell, a 10 s limit, stdout only. Undefined when it gave no token. */
function primeHook(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execSync(HOOK, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env }).trim() || undefined;
  } catch { return undefined; }
}

async function emptyHome() {
  const home = await mkdtemp(join(tmpdir(), "token-hook-home-"));
  const pool = join(home, ".config", "pi-pool");
  const tokenmaxxing = join(home, ".config", "tokenmaxxing");
  await mkdir(pool, { recursive: true });
  await mkdir(join(tokenmaxxing, "stores"), { recursive: true });
  await writeFile(join(tokenmaxxing, "accounts.json"), JSON.stringify({ version: 2, accounts: [] }));
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home, PI_POOL_DIR: pool, TOKENMAXXING_HOME: tokenmaxxing, PI_POOL_SECRETS: "file",
    PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "fixture-empty-store" };
  return { home, pool, env, sessions: join(home, ".prime", "agent", "sessions") };
}

async function writeSession(dir: string, id: string, lines: string[]) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), [header(id), ...lines].join("\n") + "\n");
}

async function bridgeFor(sessions: string, clock: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "token-hook-bridge-"));
  const boards = new BoardStore(dir);
  const watch = new TokenHookWatch({ sessionsDir: sessions, now: clock });
  const sent: string[] = [];
  const bridge = new AlertBridge({ file: join(dir, "alert-bridge.json"), boards, now: clock, log: () => {}, alerts: () => withHookAlert(Promise.resolve([]), watch),
    deliver: async (_session, text) => { sent.push(text); return "sent"; } });
  const steps = async (): Promise<PlanItem[]> => {
    const found: PlanItem[] = [];
    walkItems((await boards.read(HARNESS))?.plan ?? [], item => { if (item.note?.includes("pi-pool-token-hook")) found.push(item); });
    return found;
  };
  return { bridge, steps, sent, watch };
}

test("token hook watch: an empty store in a temp HOME makes the hook log why, and the owner's chat gets one plain alert step", async () => {
  const f = await emptyHome();
  assert.equal(primeHook(f.env), undefined);
  const log = (await readFile(join(f.pool, "pi-pool.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; reason?: string; session?: string });
  const noToken = log.filter(line => line.event === "hook_no_token");
  assert.equal(noToken.length, 1, JSON.stringify(log));
  assert.equal(noToken[0]!.reason, "RuntimeError: no anthropic account can serve this session");
  assert.equal(noToken[0]!.session, "fixture-empty-store");

  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000001", [failed(NOW - 4 * 60_000), failed(NOW - 3 * 60_000)]);
  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000002", [answered(NOW - HOOK_WINDOW_MS - 60_000), failed(NOW - 2 * 60_000)]);
  let now = NOW;
  const b = await bridgeFor(f.sessions, () => now);
  await b.bridge.tick();
  const [step, ...more] = await b.steps();
  assert.ok(step, "the bridge put no step on the owner's chat");
  assert.equal(more.length, 0);
  assert.equal(step.text, HOOK_ALERT_NAME);
  assert.match(step.note ?? "", /3 turns in 2 sessions failed/);
  assert.deepEqual(b.sent, []);

  now += 60_000;
  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000003", [failed(now - 30_000)]);
  await b.bridge.tick();
  assert.equal((await b.steps()).length, 1, "a still-failing pool adds no second step");

  now += 60_000;
  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000004", [answered(now - 10_000)]);
  await b.bridge.tick();
  const [after] = await b.steps();
  assert.match(after!.note ?? "", /The alert resolved at/);
});

test("token hook watch: one session's failures, or failures next to an answer, are not pool-wide", async () => {
  const f = await emptyHome();
  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000011", [failed(NOW - 5 * 60_000), failed(NOW - 4 * 60_000), failed(NOW - 3 * 60_000)]);
  assert.deepEqual(await new TokenHookWatch({ sessionsDir: f.sessions, now: () => NOW }).alerts(), []);
  await writeSession(f.sessions, "01a14400-0000-7000-8000-000000000012", [failed(NOW - 2 * 60_000), answered(NOW - 60_000)]);
  assert.deepEqual(await new TokenHookWatch({ sessionsDir: f.sessions, now: () => NOW }).alerts(), []);
});

test("token hook watch: only pooled hook failures inside the window count", () => {
  const since = NOW - HOOK_WINDOW_MS;
  const codex = JSON.stringify({ type: "message", timestamp: new Date(NOW).toISOString(),
    message: { role: "assistant", provider: "openai-codex", stopReason: "error", errorMessage: PRIME_ERROR.replace("\"anthropic\"", "\"openai-codex\"") } });
  const other = failed(NOW, "Provider rejected the request (invalid_request_error, 400)");
  const aborted = JSON.stringify({ type: "message", timestamp: new Date(NOW).toISOString(), message: { role: "assistant", provider: "anthropic", stopReason: "aborted" } });
  const tally = tallyTail([failed(since - 1), failed(NOW), codex, other, aborted, "{not json"].join("\n"), since);
  assert.deepEqual(tally, { failures: [NOW, NOW], answers: 0 });
});

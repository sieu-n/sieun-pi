import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { assignIdentity } from "@sieun-pi/pi-family/registry";
import { rootOf } from "../src/pi/index.ts";
import { readFailure, rewriteFailure, type PoolCall } from "../src/core/errors.ts";
import { credential, poolEnv, readVend, type Vend } from "../src/core/pool-cli.ts";
import { admitReply, placeIn } from "../src/core/turns.ts";

const failed = (errorMessage: string): AssistantMessage => ({
  role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error", errorMessage, timestamp: 1_000_000,
});
const answering = (out: unknown, ok = true): PoolCall & { seen: string[][] } => {
  const seen: string[][] = [];
  const call = (async (args: string[]) => {
    seen.push(args);
    return { ok, out: JSON.stringify(out) };
  }) as PoolCall & { seen: string[][] };
  call.seen = seen;
  return call;
};

test("readVend reads a token, the exit-75 slot wait and the hook's no-token reason", () => {
  assert.deepEqual(readVend({ code: 0, stdout: "sk-ant-oat01-x\n", stderr: "" }), { kind: "token", token: "sk-ant-oat01-x" });
  assert.deepEqual(readVend({ code: 75, stdout: '{"retryAt": 1700000000, "message": "waiting for an account slot"}', stderr: "" }), { kind: "wait", retryAt: 1700000000, message: "waiting for an account slot" });
  assert.deepEqual(readVend({ code: 1, stdout: "", stderr: "pi-pool-token: no token (no_account)\n" }), { kind: "failed", reason: "no_account" });
  assert.deepEqual(readVend({ code: 0, stdout: "", stderr: "" }), { kind: "failed", reason: "empty_result" });
  assert.deepEqual(readVend({ code: 75, stdout: "garbage", stderr: "" }), { kind: "failed", reason: "exit 75" });
});

test("poolEnv names the tree and drops Prime's worker variables", () => {
  const env = poolEnv({ root: "r", session: "c" }, "/agent", { HOME: "/h", PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "prime", PI_POOL_SESSION_KEY: "stale" });
  assert.equal(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID, undefined);
  assert.deepEqual(JSON.parse(env.PI_POOL_SESSION_KEY!), { key: "r", uuid: "r", active: "c" });
  assert.equal(env.PRIME_AGENT_CODING_AGENT_DIR, "/agent");
  assert.equal(env.HOME, "/h");
});

test("an RLM child speaks for its root's tree", () => {
  assignIdentity("child-2", { name: "w2", role: "child", parentId: "child-1", depth: 2 });
  assignIdentity("child-1", { name: "w1", role: "child", parentId: "root-0", depth: 1 });
  assert.equal(rootOf("child-2"), "root-0");
  assert.equal(rootOf("root-0"), "root-0");
});

test("credential waits through slot answers, retries failures and stops on abort", async () => {
  const script: Vend[] = [{ kind: "wait", retryAt: 0, message: "w" }, { kind: "failed", reason: "x" }, { kind: "token", token: "t" }];
  const waits: unknown[] = [];
  const got = await credential(async () => script.shift()!, undefined, w => waits.push(w));
  assert.deepEqual(got, { kind: "token", token: "t" });
  assert.equal(waits.length, 2);
  assert.equal(waits[1], undefined);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  const started = Date.now();
  assert.deepEqual(await credential(async () => ({ kind: "wait", retryAt: Date.now() / 1000 + 3600, message: "w" }), stop.signal, () => {}), { kind: "aborted" });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await credential(async () => ({ kind: "failed", reason: "no_account" }), undefined, () => {}), { kind: "failed", reason: "no_account" });
});

test("readFailure finds the status and pi-ai's retry-delay lead", () => {
  assert.deepEqual(readFailure('429 {"type":"error"}'), { status: 429, resetMs: undefined, text: '429 {"type":"error"}' });
  assert.deepEqual(readFailure('Server requested 3600s retry delay (max: 60s). 429 {"x":1}'), { status: 429, resetMs: 3_600_000, text: '429 {"x":1}' });
  assert.equal(readFailure("403 forbidden").status, 403);
  assert.equal(readFailure("Codex hit your usage limit").status, 429);
  assert.equal(readFailure("socket hang up").status, undefined);
});

test("a 429 rewrite reports the account and stays retryable even when the text says billing", async () => {
  const pool = answering({ selection: { mode: "auto" }, account: "claude7", until: 2000, next: "claude9" });
  const out = await rewriteFailure(failed('429 {"error":{"message":"billing period limit, try again in 4 hours"}}'), pool, undefined, () => 1_000_000);
  assert.deepEqual(pool.seen[0].slice(0, 3), ["limited", "--provider", "anthropic"]);
  assert.equal(Number(pool.seen[0][4]), (1_000_000 + 300_000) / 1000);
  assert.match(out!.errorMessage!, /claude7 is limited until .*; the retry uses claude9\./);
  assert.ok(isRetryableAssistantError(out!), out!.errorMessage);
});

test("a 403 refusal moves on, and a plain failure stays as it was", async () => {
  const pool = answering({ selection: { mode: "auto" }, account: "claude7", reason: "needs terms", next: "claude9" });
  const out = await rewriteFailure(failed('403 {"error":"terms"}'), pool, undefined);
  assert.match(out!.errorMessage!, /claude7 is out of the pool \(needs terms\)/);
  assert.ok(isRetryableAssistantError(out!));
  assert.equal(await rewriteFailure(failed("socket hang up"), answering({}), undefined), undefined);
  assert.equal(await rewriteFailure({ ...failed("x"), stopReason: "stop" }, answering({}), undefined), undefined);
});

test("a hook failure becomes a retryable error", async () => {
  const out = await rewriteFailure(failed("401 invalid bearer token"), answering({}), "no_account");
  assert.match(out!.errorMessage!, /no token \(no_account\)/);
  assert.ok(isRetryableAssistantError(out!));
});

test("turns.json reads and admit answers", () => {
  assert.deepEqual(placeIn('{"working":{"s":{"kind":"run"}}}', "s"), { part: "working", kind: "run" });
  assert.deepEqual(placeIn('{"queued":{"s":{}}}', "s"), { part: "queued", kind: null });
  assert.deepEqual(placeIn("{}", "s"), { part: "gone", kind: null });
  assert.equal(placeIn("nope", "s"), null);
  assert.equal(admitReply('noise\n{"state":"admitted","kind":null,"position":null,"total":null}')?.state, "admitted");
});

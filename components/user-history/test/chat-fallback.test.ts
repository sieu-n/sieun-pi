import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeDown, failureCause, fallbackModel, fallbackRecord, OWNER_RETRY_BACKOFF_MS, revivalMessage, stallAction, strandedInput, switchBack, turnStall, turnViewOf,
  type Stall } from "../src/chat-fallback.ts";
import { claudeReader, claudeStateOf } from "../src/chat-pool.ts";
import { CHAT_NOTICE, chatFeed, turnStarter, waitText } from "../src/shared/chat-feed.ts";
import type { ModelInfo, PoolAccount, ThreadMessage } from "../src/shared/types.ts";

const TOKEN_ERROR = 'Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token';
const RATE_LIMIT = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";
const user = (content: string, timestamp: number): ThreadMessage => ({ role: "user", content, timestamp });
const reply = (stopReason: "stop" | "error" | "aborted" | "toolUse", timestamp: number, errorMessage?: string): ThreadMessage =>
  ({ role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason, timestamp, ...(errorMessage ? { errorMessage } : {}) });
const view = (messages: ThreadMessage[], extra: { running?: boolean; retrying?: boolean; queued?: number; retryError?: string | null } = {}) =>
  ({ messages, running: extra.running ?? false, retrying: extra.retrying ?? false, queued: extra.queued ?? 0, retryError: extra.retryError ?? null });
const model = (provider: string, id: string, name = id): ModelInfo => ({ provider, id, name, input: ["text"], contextWindow: 0, reasoning: true });
const MIN = 60_000;

test("failure classification: a pool token failure or no account is Claude down; a 429 only when the pool has no usable account; never for a non-Anthropic chat", () => {
  assert.equal(failureCause(TOKEN_ERROR), "account");
  assert.equal(failureCause("No Claude account"), "account");
  assert.equal(failureCause(RATE_LIMIT), "rate-limit");
  assert.equal(failureCause("Connection error."), "other");
  assert.equal(failureCause("aborted"), "other");
  assert.equal(claudeDown(TOKEN_ERROR, "anthropic", null), true, "a token failure switches even when the pool cannot be read (a broken vend.py)");
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", { serves: false, freeAt: null }), true);
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", { serves: true, freeAt: null }), false, "another account serves: the pool moves the session");
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", null), false, "an unreadable pool proves nothing about a 429");
  assert.equal(claudeDown("Connection error.", "anthropic", { serves: false, freeAt: null }), false);
  assert.equal(claudeDown(TOKEN_ERROR, "openai-codex", null), false, "the owner picked a non-Anthropic model");
  assert.equal(claudeDown(TOKEN_ERROR, null, null), false);
});

test("fallback model: GPT-6 Sol when the catalog has it, else the closest configured Codex model, else none", () => {
  const sol = model("openai-codex", "gpt-6-sol", "GPT-6 Sol");
  const catalog = (models: ModelInfo[], configured = ["anthropic", "openai-codex"]) => ({ models, configuredProviders: configured });
  assert.deepEqual(fallbackModel(catalog([model("anthropic", "claude-opus-5-5"), model("openai-codex", "gpt-6-astra"), sol])), { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" });
  assert.equal(fallbackModel(catalog([model("openai-codex", "gpt-5.6-sol"), model("openai-codex", "gpt-6-sol-1"), model("openai-codex", "gpt-6-astra")]))?.id, "gpt-6-sol-1");
  assert.equal(fallbackModel(catalog([model("openai-codex", "gpt-6-astra"), model("openai-codex", "gpt-6-terra")]))?.id, "gpt-6-terra", "a tie goes to the later id");
  assert.equal(fallbackModel(catalog([sol], ["anthropic"])), null, "Codex has no key");
  assert.equal(fallbackModel(catalog([model("anthropic", "claude-opus-5-5")])), null);
});

test("turn stall: a failed reply with nothing after it; the owner's unanswered message on an owner turn; a Stop, a check-in turn, a good or running turn", () => {
  const asked = "what was the response to t5 question???";
  const owner = user(asked, 1);
  assert.deepEqual(turnStall(view([owner, reply("error", 5, RATE_LIMIT)]), 99),
    { error: RATE_LIMIT, at: 5, owner: "what was the response to t5 question???", aborted: false, retrying: false, queued: 0 });
  assert.equal(turnStall(view([owner, reply("toolUse", 3), reply("error", 5, TOKEN_ERROR)]), 99)?.owner, asked, "a failure after tool calls still quotes the owner");
  assert.deepEqual(turnStall(view([owner, reply("aborted", 6)]), 99), { error: "aborted", at: 6, owner: null, aborted: true, retrying: false, queued: 0 }, "a Stop is no unanswered message");
  assert.equal(turnStall(view([user("[check-in] What changed: p1", 1), reply("error", 5, RATE_LIMIT)]), 99)?.owner, null, "a check-in turn is not the owner's");
  assert.equal(turnStall(view([owner, reply("error", 5, "x"), { role: "custom", customType: "refinement_notice", content: "x", timestamp: 8 }]), 99)?.error, "x");
  assert.equal(turnStall(view([reply("error", 5, "429"), owner]), 99), null, "the owner wrote after it: a new turn");
  assert.equal(turnStall(view([owner, reply("stop", 5)]), 99), null);
  assert.equal(turnStall(view([owner, reply("error", 5, "429")], { running: true }), 99), null, "a turn runs now");
  assert.equal(turnStall(view([]), 99), null);
  const retry = revivalMessage("429", asked);
  assert.equal(retry, `[check-in] Your last turn failed (429). The owner's message is still unanswered: "what was the response to t5 question???". Answer it first.`);
  assert.equal(turnStall(view([owner, reply("error", 5, "429"), user(retry, 40), reply("error", 45, RATE_LIMIT)]), 99)?.owner, asked,
    "a failed owner retry quotes the same message again, not the retry text");
  assert.equal(revivalMessage("429"), "[check-in] Your last turn failed (429). Re-check the board and continue.");
});

test("turn stall: a provider retry holds the turn; its queued input is stranded", () => {
  const messages = [user("continue", 1), reply("error", 5, RATE_LIMIT)];
  const held = turnStall(view(messages, { running: true, retrying: true, queued: 3, retryError: RATE_LIMIT }), 99);
  assert.deepEqual(held, { error: RATE_LIMIT, at: 5, owner: "continue", aborted: false, retrying: true, queued: 3 });
  assert.equal(strandedInput(held), true);
  assert.equal(turnStall(view([user("continue", 1)], { running: true, retrying: true }), 99)?.at, 99, "a retry whose failed reply the hub lost counts from now");
  assert.equal(strandedInput(turnStall(view(messages), 99)), false, "nothing queued");
  assert.equal(strandedInput(null), false);
  assert.deepEqual(turnViewOf({ messages, info: { retryAttempt: 2, queuedActions: 1 }, queue: { steering: ["a"], followUp: ["b"] }, retry: { error: "429" } }, true),
    { messages, running: true, retrying: true, queued: 3, retryError: "429" });
});

test("stall action: an owner turn restarts after 30 s, then 5, 10, 20 min; others after 5 min; a provider retry with nothing queued is left alone; the wait the feed shows", () => {
  const stall = (owner: string | null, extra: Partial<Stall> = {}): Stall => ({ error: "429", at: 0, owner, aborted: false, retrying: false, queued: 0, ...extra });
  const act = (s: Stall, attempts: number, since: number, now: number, down = false, freeAt: number | null = null) =>
    stallAction({ stall: s, down, claude: down ? { serves: false, freeAt } : { serves: true, freeAt: null }, attempts, since, now });
  assert.deepEqual(OWNER_RETRY_BACKOFF_MS, [30_000, 5 * MIN, 10 * MIN, 20 * MIN]);
  assert.deepEqual(act(stall("hi"), 0, 0, 29_999), { kind: "wait", wait: { kind: "retry", error: "429", at: 30_000 } });
  assert.deepEqual(act(stall("hi"), 0, 0, 30_000), { kind: "restart", message: revivalMessage("429", "hi"), abort: false });
  assert.equal(act(stall("hi"), 1, 30_000, 30_000 + 5 * MIN - 1).kind, "wait");
  assert.equal(act(stall("hi"), 1, 30_000, 30_000 + 5 * MIN).kind, "restart");
  assert.deepEqual(act(stall(null), 0, 0, 5 * MIN - 1), { kind: "wait", wait: null }, "no line under a turn the owner did not start");
  assert.equal(act(stall(null), 0, 0, 5 * MIN).kind, "restart");
  assert.deepEqual(act(stall("hi", { retrying: true }), 0, 0, 10 * MIN), { kind: "none" }, "the session's own retry runs");
  assert.deepEqual(act(stall(null, { retrying: true, queued: 2 }), 0, 0, 5 * MIN), { kind: "restart", message: revivalMessage("429"), abort: true });
  assert.deepEqual(act(stall("hi"), 0, 0, 10_000, true, 45 * MIN), { kind: "wait", wait: { kind: "account", until: 45 * MIN } }, "no fallback: wait for the pool's reset");
  assert.deepEqual(act(stall("hi"), 0, 0, 10_000, true, null), { kind: "wait", wait: { kind: "account", until: 30_000 } }, "no reset known: the next try");
});

test("switch back: between turns once Claude serves; the owner moved off the fallback: forget and keep the model", () => {
  const entry = { original: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "high" as const }, fallback: { provider: "openai-codex", id: "gpt-6-sol" }, at: 1 };
  const sol = { provider: "openai-codex", id: "gpt-6-sol" };
  assert.equal(switchBack(entry, sol, false, { serves: true, freeAt: null }), "back");
  assert.equal(switchBack(entry, sol, true, { serves: true, freeAt: null }), "keep", "mid-turn");
  assert.equal(switchBack(entry, sol, false, { serves: false, freeAt: null }), "keep");
  assert.equal(switchBack(entry, sol, false, null), "keep", "the pool cannot be read");
  assert.equal(switchBack(entry, { provider: "openai-codex", id: "gpt-6-astra" }, false, { serves: true, freeAt: null }), "forget");
  assert.equal(switchBack(entry, null, false, { serves: true, freeAt: null }), "forget");
});

test("fallback record: the original model per chat, through locked-json", async () => {
  const record = fallbackRecord(join(await mkdtemp(join(tmpdir(), "fallback-")), "chat-fallbacks.json"));
  const entry = { original: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "max" as const }, fallback: { provider: "openai-codex", id: "gpt-6-sol" }, at: 5 };
  assert.equal(await record.get("c1"), undefined);
  await record.set("c1", entry);
  assert.deepEqual(await record.get("c1"), entry);
  assert.deepEqual(await record.ids(), ["c1"]);
  await record.forget("c1");
  assert.equal(await record.get("c1"), undefined);
});

test("pool: Claude serves when an account that is on is usable; it frees up at the earliest limit, cooldown or spent-window reset", async () => {
  const row = (over: Partial<PoolAccount>): PoolAccount => ({ id: "a", email: "a@x", usage: "", reason: null, usable: false, current: false, pinned: false, force: false, live: true, seat: false,
    session_pct: null, weekly_pct: null, score: null, tier: null, windows: [], usageAt: null, cooldownUntil: null, cooldownReason: null, limitedUntil: null, disabled: false, ...over });
  const now = 1_000_000;
  assert.deepEqual(claudeStateOf([row({ limitedUntil: now + 600_000 }), row({ cooldownUntil: now + 300_000, limitedUntil: now - 1 }),
    row({ windows: [{ kind: "session", label: "5h", pct: 100, resetsAt: now + 900_000 }] }), row({ usable: true, disabled: true })], now), { serves: false, freeAt: now + 300_000 });
  assert.deepEqual(claudeStateOf([row({ usable: true })], now), { serves: true, freeAt: null });
  assert.deepEqual(claudeStateOf([], now), { serves: false, freeAt: null });
  let reads = 0;
  let clock = 0;
  const listing = JSON.stringify({ provider: "anthropic", rows: [{ id: "a", email: "a@x", usage: "", reason: null, usable: true, current: true, pinned: false, force: false, live: true, seat: false }] });
  const reader = claudeReader(60_000, () => clock, async () => { reads++; return listing; });
  assert.deepEqual(await reader(), { serves: true, freeAt: null });
  clock = 59_999;
  await reader();
  assert.equal(reads, 1, "cached for a minute");
  clock = 60_000;
  await reader();
  assert.equal(reads, 2);
  assert.equal(await claudeReader(60_000, () => 0, async () => { throw new Error("pi-pool failed"); })(), null);
});

test("feed: an owner retry keeps the owner's turn; a server notice is one muted line; the wait shows under the owner's message", () => {
  const owner = user("can you use gpt-sol subagents", 1);
  const failed = reply("error", 2, RATE_LIMIT);
  const retry = user(revivalMessage("429", "can you use gpt-sol subagents"), 3);
  assert.equal(turnStarter([owner, failed, retry]), "owner", "the chat answers the owner in a bubble, and check-ins wait");
  assert.equal(turnStarter([owner, failed, user(revivalMessage("429"), 3)]), "agent");
  const notice: ThreadMessage = { role: "custom", customType: CHAT_NOTICE, content: "Claude has no free account; switched to GPT-6 Sol. I switch back when one frees up.", timestamp: 4 };
  const items = chatFeed({ messages: [owner, failed, notice], streaming: null, wait: null });
  assert.deepEqual(items.at(-1), { kind: "notice", id: "m2", text: "Claude has no free account; switched to GPT-6 Sol. I switch back when one frees up.", at: 4 });
  const at = new Date(2026, 9, 8, 17, 45).getTime();
  const waiting = chatFeed({ messages: [owner, failed], streaming: null, wait: { kind: "account", until: at } });
  assert.deepEqual(waiting.at(-1), { kind: "notice", id: "wait", text: "Waiting for a Claude account until 17:45.", at: 2 });
  assert.equal(waitText({ kind: "retry", error: "Connection error.", at: new Date(2026, 9, 8, 9, 5).getTime() }), "Turn failed (Connection error.). Retrying at 09:05.");
  assert.equal(waitText({ kind: "account", until: null }), "Waiting for a Claude account.");
});

test("failure cause: a 401 or a Consumer Terms 400 counts like a 429 (down only when the pool has no usable account)", () => {
  assert.equal(failureCause("Provider authentication failed (authentication_error, 401): Invalid authentication credentials"), "rate-limit");
  assert.equal(failureCause("400 Please accept the updated Consumer Terms to continue"), "rate-limit");
  assert.equal(failureCause("Connection error."), "other");
});

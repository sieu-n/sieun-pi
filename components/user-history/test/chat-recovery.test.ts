import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeDown, failureCause, jobWake, type JobWake, OWNER_RETRY_BACKOFF_MS, poolSlot, revivalMessage, stallAction, strandedInput,
  TRANSIENT_RETRY_BACKOFF_MS, turnStall, turnViewOf, wokeFromSleep, type Stall } from "../src/chat-recovery.ts";
import { claudeReader, claudeStateOf } from "../src/chat-pool.ts";
import { chatFeed, turnStarter, waitText } from "../src/shared/chat-feed.ts";
import type { PoolAccount, ThreadMessage } from "../src/shared/types.ts";

const TOKEN_ERROR = 'Failed to resolve API key for provider "anthropic" from shell command: /home/sam/.config/pi-pool/bin/pi-pool-token';
const RATE_LIMIT = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";
const user = (content: string, timestamp: number): ThreadMessage => ({ role: "user", content, timestamp });
const reply = (stopReason: "stop" | "error" | "aborted" | "toolUse", timestamp: number, errorMessage?: string): ThreadMessage =>
  ({ role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason, timestamp, ...(errorMessage ? { errorMessage } : {}) });
const view = (messages: ThreadMessage[], extra: { running?: boolean; retrying?: boolean; queued?: number; retryError?: string | null } = {}) =>
  ({ messages, running: extra.running ?? false, retrying: extra.retrying ?? false, queued: extra.queued ?? 0, retryError: extra.retryError ?? null });
const MIN = 60_000;

const CODEX_TOKEN_ERROR = 'Failed to resolve API key for provider "openai-codex" from shell command: /home/sam/.config/pi-pool/bin/pi-pool-token';

test("failure classification: the token command and a dropped connection are transient; no account is Claude down; a 429, 401 or Terms 400 only when the pool has no usable account", () => {
  const table: [string, ReturnType<typeof failureCause>][] = [
    [TOKEN_ERROR, "transient"], [CODEX_TOKEN_ERROR, "transient"], ["Connection error.", "transient"], ["TypeError: fetch failed", "transient"],
    ["read ECONNRESET", "transient"], ["connect ETIMEDOUT 160.79.104.10:443", "transient"], ["socket hang up", "transient"],
    ["No Claude account", "account"], ['No API key for provider: anthropic', "account"],
    [RATE_LIMIT, "rate-limit"], ["Provider authentication failed (authentication_error, 401): Invalid authentication credentials", "rate-limit"],
    ["400 Please accept the updated Consumer Terms to continue", "rate-limit"], ["aborted", "other"], ["Context window exceeded", "other"],
  ];
  for (const [error, cause] of table) assert.equal(failureCause(error), cause, error);
  const serving = { serves: true, freeAt: null }, notServing = { serves: false, freeAt: null };
  assert.equal(claudeDown(TOKEN_ERROR, "anthropic", null), false, "an unreadable pool after a token timeout means retry, unknown availability (10-05 battery sleep)");
  assert.equal(claudeDown(TOKEN_ERROR, "anthropic", serving), false, "an account serves: the token command only timed out");
  assert.equal(claudeDown(TOKEN_ERROR, "anthropic", notServing), true, "the pool is read and no account serves");
  assert.equal(claudeDown("Connection error.", "anthropic", null), false);
  assert.equal(claudeDown("Connection error.", "anthropic", serving), false);
  assert.equal(claudeDown("Connection error.", "anthropic", notServing), true);
  assert.equal(claudeDown("No Claude account", "anthropic", null), true, "the provider reported no account even though the pool reader failed");
  assert.equal(claudeDown("No Claude account", "anthropic", notServing), true);
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", notServing), true);
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", serving), false, "another account serves: the pool moves the session");
  assert.equal(claudeDown(RATE_LIMIT, "anthropic", null), false, "an unreadable pool proves nothing about a 429");
  assert.equal(claudeDown(TOKEN_ERROR, "openai-codex", notServing), false, "the owner picked a non-Anthropic model");
  assert.equal(claudeDown(TOKEN_ERROR, null, null), false);
});

test("transient stalls: 30 s, 1 min, 2 min, then 5, 10, 20 min; an owner turn still quotes the owner; a wake from sleep restarts at once", () => {
  const stall = (owner: string | null, extra: Partial<Stall> = {}): Stall => ({ error: TOKEN_ERROR, at: 0, owner, aborted: false, retrying: false, queued: 0, ...extra });
  const act = (s: Stall, attempts: number, since: number, now: number, woke = false) =>
    stallAction({ stall: s, down: false, claude: null, attempts, since, now, woke });
  assert.deepEqual(TRANSIENT_RETRY_BACKOFF_MS, [30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 20 * MIN]);
  const due = (owner: string | null) => TRANSIENT_RETRY_BACKOFF_MS.map((wait, attempts) => [act(stall(owner), attempts, 0, wait - 1).kind, act(stall(owner), attempts, 0, wait).kind]);
  assert.deepEqual(due(null), TRANSIENT_RETRY_BACKOFF_MS.map(() => ["wait", "restart"]));
  assert.deepEqual(due("hi"), TRANSIENT_RETRY_BACKOFF_MS.map(() => ["wait", "restart"]));
  assert.deepEqual(act(stall("hi"), 2, 0, MIN), { kind: "wait", wait: { kind: "retry", error: TOKEN_ERROR, at: 2 * MIN } });
  assert.deepEqual(act(stall("hi"), 0, 0, 30_000), { kind: "restart", message: revivalMessage(stall("hi")), abort: false });
  assert.equal(act(stall(null, { error: "Connection error." }), 1, 0, MIN).kind, "restart", "a dropped connection is on the fast schedule too");
  assert.equal(act(stall(null, { error: "429" }), 1, 0, MIN).kind, "wait", "a 429 stays on the 5, 10, 20 min schedule");
  assert.deepEqual(act(stall("hi"), 5, 0, 1, true), { kind: "restart", message: revivalMessage(stall("hi")), abort: false }, "after a sleep: at once, whatever the count");
  assert.deepEqual(act(stall(null, { error: "Connection error.", retrying: true }), 0, 0, 1, true), { kind: "restart", message: revivalMessage(stall(null, { error: "Connection error." })), abort: true },
    "a provider retry left over from before the sleep is stopped");
  assert.equal(act(stall(null, { error: "429" }), 0, 0, 1, true).kind, "wait", "a wake does not hurry a 429");
  assert.equal(act(stall(null, { error: "aborted", aborted: true }), 0, 0, 1, true).kind, "wait", "a Stop is not transient");
});

test("pool slot: a stall the pool turned into a wait for the session's slot is not restarted or woken before that slot, queued input, sleep or not", () => {
  // 10-13 11:57Z to 13:42Z: the pool gave 6 chats slots on claude11 and the Virev seat. The check-in restarted each chat's pool wait 54 times
  // (abort, "[check-in] Your last turn failed", a new request), and every restart met the same 429 until the slot.
  const slot = Date.parse("2026-10-13T13:42:00.000Z");
  const waited = `${RATE_LIMIT} [request_id: req_1] pi-pool: claude11@x is limited until 2026-10-13T13:40:00.000Z; this session waits for its slot at 2026-10-13T13:42:00.000Z. Try again in 15 minutes.`;
  const hookWait = `${TOKEN_ERROR} pi-pool: this session waits for its slot at 2026-10-13T13:42:00.000Z. Try again in 2 minutes.`;
  assert.equal(poolSlot(waited), slot);
  assert.equal(poolSlot(hookWait), slot);
  assert.equal(poolSlot(`${RATE_LIMIT} pi-pool: a@x is limited until 2026-10-13T13:40:00.000Z; the retry uses b@x.`), null, "a move to another account is no wait");
  assert.equal(poolSlot(RATE_LIMIT), null);
  const owner = user("go", slot - 120 * MIN);
  const stalled = turnStall(view([owner, reply("error", slot - 105 * MIN, waited)], { running: true, retrying: true, queued: 2, retryError: waited }), slot - 100 * MIN);
  assert.equal(stalled?.slotAt, slot, "the slot is read past the 160-character clip");
  const act = (s: Stall, now: number, woke = false, down = true) => stallAction({ stall: s, down, claude: { serves: false, freeAt: null }, attempts: 3, since: slot - 105 * MIN, now, woke });
  assert.deepEqual(act(stalled!, slot - 1), { kind: "wait", wait: { kind: "account", until: slot } }, "queued input and no usable account: the owner sees the slot");
  assert.deepEqual(act({ ...stalled!, owner: null }, slot - 1), { kind: "wait", wait: null });
  assert.equal(act({ ...stalled!, error: hookWait }, slot - 1, true).kind, "wait", "a hook slot wait after a sleep still waits");
  assert.equal(act(stalled!, slot).kind, "restart", "at the slot the usual schedule applies");
  const job = { ...stalled!, error: hookWait, owner: null, at: slot - 3 * MIN };
  assert.equal(jobWake({ stall: job, last: undefined, woke: true, now: slot - MIN }), "wait");
  assert.equal(jobWake({ stall: job, last: undefined, woke: false, now: slot }), "wake");
});

test("sleep: a gap of more than 90 s between two scheduler wakes means the Mac slept", () => {
  assert.equal(wokeFromSleep(null, 1_000_000), false, "the first wake");
  assert.equal(wokeFromSleep(0, 30_000), false);
  assert.equal(wokeFromSleep(0, 90_000), false);
  assert.equal(wokeFromSleep(0, 90_001), true);
  assert.equal(wokeFromSleep(0, 40 * MIN), true);
});

test("job wake: a transient failure is woken once per failure on the fast schedule, at once after a sleep, queued input or not", () => {
  const failed = (at: number, extra: Partial<Stall> = {}): Stall => ({ error: TOKEN_ERROR, at, owner: null, aborted: false, retrying: false, queued: 0, ...extra });
  const wake = (stall: Stall | null, last: JobWake | undefined, now: number, woke = false) => jobWake({ stall, last, woke, now });
  assert.equal(wake(null, undefined, 0), "none", "the last turn ended well");
  assert.equal(wake(failed(0, { error: "429" }), undefined, 10 * MIN), "none", "a 429 is not this path's");
  assert.equal(wake(failed(0, { error: "aborted", aborted: true }), undefined, 10 * MIN), "none", "a Stop");
  assert.equal(wake(failed(0), undefined, 29_999), "wait");
  assert.equal(wake(failed(0), undefined, 30_000), "wake", "30 s after the failure, nothing queued");
  assert.equal(wake(failed(0), { failureAt: 0, attempts: 1, at: 30_000 }, 60 * MIN), "wait", "once per failure");
  assert.equal(wake(failed(40_000), { failureAt: 0, attempts: 1, at: 30_000 }, 30_000 + MIN - 1), "wait", "the woken turn failed again: 1 min after the last wake");
  assert.equal(wake(failed(40_000), { failureAt: 0, attempts: 1, at: 30_000 }, 30_000 + MIN), "wake");
  assert.equal(wake(failed(9 * MIN), { failureAt: 8 * MIN, attempts: 3, at: 8 * MIN }, 8 * MIN + 5 * MIN), "wake", "then 5 min");
  assert.equal(wake(failed(9 * MIN), { failureAt: 8 * MIN, attempts: 3, at: 8 * MIN }, 9 * MIN + 1, true), "wake", "after a sleep: at once");
  assert.equal(wake(failed(9 * MIN), { failureAt: 9 * MIN, attempts: 3, at: 9 * MIN }, 20 * MIN, true), "wait", "a failure already woken is not woken again by a sleep");
  assert.equal(wake(failed(0, { error: "Connection error.", retrying: true }), undefined, 10 * MIN), "wait", "a provider retry with nothing queued is the session's own");
  assert.equal(wake(failed(0, { error: "Connection error.", retrying: true, queued: 1 }), undefined, 30_000), "wake");
  assert.equal(wake(failed(0, { error: "Connection error.", retrying: true }), undefined, 1, true), "wake", "after a sleep the retry is stopped");
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
  const at = new Date(2026, 9, 8, 21, 14).getTime();
  const retry = revivalMessage({ error: "429", at, owner: asked });
  assert.equal(retry, `[check-in] Your last turn failed at 21:14 (429). The owner's message is still unanswered: "what was the response to t5 question???". Answer it first.`);
  assert.equal(turnStall(view([owner, reply("error", 5, "429"), user(retry, 40), reply("error", 45, RATE_LIMIT)]), 99)?.owner, asked,
    "a failed owner retry quotes the same message again, not the retry text");
  assert.equal(revivalMessage({ error: "429", at, owner: null }), "[check-in] Your last turn failed at 21:14 (429). Re-check the board and continue.", "the failure time tells two failures apart");
});

test("turn stall: a provider retry holds the turn; its queued input is stranded", () => {
  const messages = [user("continue", 1), reply("error", 5, RATE_LIMIT)];
  const held = turnStall(view(messages, { running: true, retrying: true, queued: 3, retryError: RATE_LIMIT }), 99);
  assert.deepEqual(held, { error: RATE_LIMIT, at: 5, owner: "continue", aborted: false, retrying: true, queued: 3 });
  assert.equal(strandedInput(held, 99), true);
  assert.equal(turnStall(view([user("continue", 1)], { running: true, retrying: true }), 99)?.at, 99, "a retry whose failed reply the hub lost counts from now");
  assert.equal(strandedInput(turnStall(view(messages), 99), 99), false, "nothing queued");
  assert.equal(strandedInput(null, 99), false);
  assert.deepEqual(turnViewOf({ messages, info: { retryAttempt: 2, queuedActions: 1 }, queue: { steering: ["a"], followUp: ["b"] }, retry: { error: "429" } }, true),
    { messages, running: true, retrying: true, queued: 3, retryError: "429" });
});

test("stall action: an owner turn restarts after 30 s, then 5, 10, 20 min; others after 5 min; a provider retry with nothing queued is left alone; the wait the feed shows", () => {
  const stall = (owner: string | null, extra: Partial<Stall> = {}): Stall => ({ error: "429", at: 0, owner, aborted: false, retrying: false, queued: 0, ...extra });
  const act = (s: Stall, attempts: number, since: number, now: number, down = false, freeAt: number | null = null) =>
    stallAction({ stall: s, down, claude: down ? { serves: false, freeAt } : { serves: true, freeAt: null }, attempts, since, now });
  assert.deepEqual(OWNER_RETRY_BACKOFF_MS, [30_000, 5 * MIN, 10 * MIN, 20 * MIN]);
  assert.deepEqual(act(stall("hi"), 0, 0, 29_999), { kind: "wait", wait: { kind: "retry", error: "429", at: 30_000 } });
  assert.deepEqual(act(stall("hi"), 0, 0, 30_000), { kind: "restart", message: revivalMessage(stall("hi")), abort: false });
  assert.equal(act(stall("hi"), 1, 30_000, 30_000 + 5 * MIN - 1).kind, "wait");
  assert.equal(act(stall("hi"), 1, 30_000, 30_000 + 5 * MIN).kind, "restart");
  assert.deepEqual(act(stall(null), 0, 0, 5 * MIN - 1), { kind: "wait", wait: null }, "no line under a turn the owner did not start");
  assert.equal(act(stall(null), 0, 0, 5 * MIN).kind, "restart");
  assert.deepEqual(act(stall("hi", { retrying: true }), 0, 0, 10 * MIN), { kind: "none" }, "the session's own retry runs");
  assert.deepEqual(act(stall(null, { retrying: true, queued: 2 }), 0, 0, 5 * MIN), { kind: "restart", message: revivalMessage(stall(null)), abort: true });
  assert.deepEqual(act(stall("hi"), 0, 0, 10_000, true, 45 * MIN), { kind: "wait", wait: { kind: "account", until: 45 * MIN } }, "wait for the pool's reset on the selected model");
  assert.deepEqual(act(stall("hi"), 0, 0, 10_000, true, null), { kind: "wait", wait: { kind: "account", until: 30_000 } }, "no reset known: the next try");
});

test("pool: Claude serves when an account that is on is usable; it frees up at the earliest limit, cooldown or spent-window reset", async () => {
  const row = (over: Partial<PoolAccount>): PoolAccount => ({ id: "a", email: "a@x", label: "a@x", usage: "", reason: null, usable: false, current: false, pinned: false, seat: false,
    session_pct: null, weekly_pct: null, score: null, tier: null, windows: [], usageAt: null, cooldownUntil: null, cooldownReason: null, limitedUntil: null, disabled: false, sessions: 0, ...over });
  const now = 1_000_000;
  assert.deepEqual(claudeStateOf([row({ limitedUntil: now + 600_000 }), row({ cooldownUntil: now + 300_000, limitedUntil: now - 1 }),
    row({ windows: [{ kind: "session", label: "5h", pct: 100, resetsAt: now + 900_000 }] }), row({ usable: true, disabled: true })], now), { serves: false, freeAt: now + 300_000 });
  assert.deepEqual(claudeStateOf([row({ usable: true })], now), { serves: true, freeAt: null });
  assert.deepEqual(claudeStateOf([], now), { serves: false, freeAt: null });
  let reads = 0;
  let clock = 0;
  const listing = JSON.stringify({ provider: "anthropic", rows: [{ id: "a", email: "a@x", label: "a@x", usage: "", reason: null, usable: true, current: true, pinned: false, seat: false }] });
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

test("feed: an owner retry stays on the owner turn; the provider failure and selected-model wait stay visible", () => {
  const owner = user("can you use gpt-sol subagents", 1);
  const failed = reply("error", 2, RATE_LIMIT);
  const retry = user(revivalMessage({ error: "429", at: 2, owner: "can you use gpt-sol subagents" }), 3);
  assert.equal(turnStarter([owner, failed, retry]), "owner");
  assert.equal(turnStarter([owner, failed, user(revivalMessage({ error: "429", at: 2, owner: null }), 3)]), "agent");
  const at = new Date(2026, 9, 8, 17, 45).getTime();
  const waiting = chatFeed({ messages: [owner, failed], streaming: null, wait: { kind: "account", until: at } });
  assert.deepEqual(waiting.at(-1), { kind: "notice", id: "wait", text: "Waiting for a Claude account until 17:45. Your selected model stays unchanged.", at: 2 });
  assert.equal(waitText({ kind: "retry", error: "Connection error.", at: new Date(2026, 9, 8, 9, 5).getTime() }), "Turn failed (Connection error.). Retrying at 09:05.");
  assert.equal(waitText({ kind: "account", until: null }), "Waiting for a Claude account. Your selected model stays unchanged.");
});

test("failure cause: a 401 or a Consumer Terms 400 counts like a 429 (down only when the pool has no usable account)", () => {
  assert.equal(failureCause("Provider authentication failed (authentication_error, 401): Invalid authentication credentials"), "rate-limit");
  assert.equal(failureCause("400 Please accept the updated Consumer Terms to continue"), "rate-limit");
  assert.equal(failureCause("Connection error."), "transient");
});

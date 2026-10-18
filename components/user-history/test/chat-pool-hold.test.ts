// Crawler VP (01a115e2) on 10-18: its turn met 429s on claude4 at 18:17Z, 19:41:43Z and 19:53:54Z, and pi-pool's last answer said "this
// session waits for its slot at 21:49:27Z". Prime slept in its provider retry while job reports queued up (the outbox read 20 of 20, and
// 19 reached the transcript at the abort). The service's revive kept the hold (poolHolds) until a hand abort at 20:54:52Z, and then pi-pool
// gave the tree claude7 at once (pi-pool.log unparked and vend at 20:54:52). The fixture is the trimmed tail of the chat's session file
// from the turn's start to that abort.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { poolAdmits, poolAdmitsNow, type PoolPart, type PoolThread, type ThreadParts, threadKey, type readPoolStatus } from "../src/chat-pool.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ModelInfo, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "crawler-vp-pool-hold-1018.jsonl");
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const CLAUDE4 = "claude4-id", CLAUDE7 = "7bec9951-a318-4634-a390-ebb5294a7c70";
const SLOT = Date.parse("2026-10-18T21:49:27Z") / 1000;
const ABORT = "2026-10-18T20:54:52";
const at = (clock: string): number => Date.parse(`2026-10-18T${clock}Z`);

type Entry = { type: string; timestamp: string; customType?: string; content?: string; message?: ThreadMessage & { errorMessage?: string; stopReason?: string } };
const entries: Entry[] = (await readFile(FIXTURE, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry);
/** What the hub held before the abort: the transcript to the 19:53:54Z failure, and the reports that sat queued behind it. */
const transcript = entries.filter(entry => entry.type === "message" && entry.timestamp < ABORT).map(entry => entry.message!);
const queued = entries.filter(entry => entry.customType === "agent_message" && entry.timestamp.startsWith(ABORT)).map(entry => entry.content!);
const retryError = transcript.at(-1)!.errorMessage!;

const part = (value: unknown, code = 0): PoolPart => ({ code, out: typeof value === "string" ? value : JSON.stringify(value), err: code ? "pi-pool: no answer" : "" });
/** `pi-pool who --json --session <chat>` as it answers on this box, the tree held for claude7 until its slot, or given claude7 now. */
const who = (said: Record<string, unknown>): PoolPart => part({ session: CHAT, priority: "high", providers: { anthropic: { email: null, label: null, pinned: false, ...said } } });
const HELD = who({ account: null, reason: "wait", wait: { account: CLAUDE7, slot_at: SLOT } });
const ADMITTED = who({ account: CLAUDE7, reason: "switch", wait: null });
const listing = (claude7Usable: boolean): PoolPart => part({ provider: "anthropic", wait: null, rows: [
  { id: CLAUDE4, email: "claude4@slack.green", usable: false, reason: "limited" },
  { id: CLAUDE7, email: "claude7@slack.green", usable: claude7Usable, reason: claude7Usable ? null : "session 100%" }] });
const parts = (answer: PoolPart, ls = listing(true)): ThreadParts => ({ who: answer, ls: { anthropic: ls, "openai-codex": part({ provider: "openai-codex", rows: [] }) } });

test("the fixture is the hold: a pool slot at 21:49:27Z on the last failure and 19 reports queued behind it", () => {
  assert.match(retryError, /waits for its slot at 2026-10-18T21:49:27\.000Z/);
  assert.equal(transcript.at(-1)!.stopReason, "error");
  assert.equal(queued.length, 19);
  assert.equal(entries.at(-1)!.message!.stopReason, "aborted", "the tail ends on the 20:54:52Z hand abort");
});

test("poolAdmitsNow follows account_blocker(strict=True): an account, no wait ahead, listed usable; any read that fails holds", () => {
  const now = at("20:30:00");
  assert.equal(poolAdmitsNow(parts(HELD), "anthropic", now), false, "a wait with its slot ahead holds");
  assert.equal(poolAdmitsNow(parts(ADMITTED), "anthropic", now), true);
  assert.equal(poolAdmitsNow(parts(who({ account: CLAUDE7, wait: { account: CLAUDE7, slot_at: SLOT } })), "anthropic", now), false, "an account with a wait ahead holds");
  assert.equal(poolAdmitsNow(parts(who({ account: CLAUDE7, wait: { account: CLAUDE7, slot_at: at("20:29:00") / 1000 } })), "anthropic", now), true, "a slot already passed");
  assert.equal(poolAdmitsNow(parts(ADMITTED, listing(false)), "anthropic", now), false, "the account is not usable");
  assert.equal(poolAdmitsNow(parts(who({ account: "unlisted", wait: null })), "anthropic", now), false, "ls does not list the account");
  assert.equal(poolAdmitsNow(parts(who({ account: null, reason: "none", wait: null })), "anthropic", now), false, "no account can serve");
  assert.equal(poolAdmitsNow(parts(part("", 1)), "anthropic", now), false, "who failed");
  assert.equal(poolAdmitsNow(parts(ADMITTED, part("", 1)), "anthropic", now), false, "ls failed");
  assert.equal(poolAdmitsNow(parts(part("not json")), "anthropic", now), false, "who did not parse");
  assert.equal(poolAdmitsNow(parts(part({ session: CHAT, providers: {} })), "anthropic", now), false, "who gave no anthropic answer");
});

test("poolAdmits asks a fresh read for the tree root alone, and a read that throws holds", async () => {
  const asked: { threads: readonly PoolThread[]; maxAgeMs?: number }[] = [];
  const read = (answer: PoolPart | Error): typeof readPoolStatus => async (threads = [], options = {}) => {
    asked.push({ threads, ...options });
    if (answer instanceof Error) throw answer;
    return { at: 0, queue: part({}), config: part({}), threads: new Map(threads.map(thread => [threadKey(thread), { ...parts(answer), at: 0 }])) };
  };
  assert.equal(await poolAdmits(CHAT, "anthropic", read(ADMITTED), () => at("20:30:00")), true);
  assert.deepEqual(asked, [{ threads: [{ session: CHAT, model: null }], maxAgeMs: 0 }]);
  assert.equal(await poolAdmits(CHAT, "anthropic", read(HELD), () => at("20:30:00")), false);
  assert.equal(await poolAdmits(CHAT, "anthropic", read(new Error("pi-pool failed: timeout")), () => at("20:30:00")), false);
});

test("replay: the chat's revive keeps the pool hold while pi-pool holds the tree, and aborts and resumes it once pi-pool would admit it", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-pool-hold-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set(CHAT, transcript);
  const hub = (waiting: readonly string[]) => threads.extras.set(CHAT, {
    info: { model: { provider: "anthropic", id: "claude-opus-5-5" } as ModelInfo, retryAttempt: 3, queuedActions: 0 },
    queue: { steering: waiting, followUp: [] }, retry: { error: retryError } } as never);
  hub(queued);
  threads.busyIds.add(CHAT);
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = at("20:00:00");
  let answer: PoolPart | Error = HELD;
  const asked: string[] = [];
  const read: typeof readPoolStatus = async (asks = []) => {
    if (answer instanceof Error) throw answer;
    return { at: now, queue: part({}), config: part({}), threads: new Map(asks.map(thread => [threadKey(thread), { ...parts(answer as PoolPart), at: now }])) };
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")), {
    ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home,
    poolAdmits: async (tree, provider) => { asked.push(`${tree} ${provider}`); return poolAdmits(tree, provider, read, () => now); } });
  const wake = async (clock: string) => {
    now = at(clock);
    calls.length = 0;
    await chats.tick();
    await chats.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return calls.filter(call => call.startsWith("restart ") || call.startsWith("abort "));
  };

  assert.deepEqual(await wake("20:00:00"), [], "pi-pool still holds the tree until 21:49:27Z");
  answer = new Error("pi-pool failed: timeout");
  assert.deepEqual(await wake("20:10:00"), [], "a pool read that fails counts as held");
  answer = ADMITTED;
  hub([]);
  assert.deepEqual(await wake("20:20:00"), [], "with nothing queued the retry stays the session's own");
  assert.equal(asked.length, 2, "the pool is asked only for a hold with input queued");
  hub(queued);
  const restarted = await wake("20:30:00");
  assert.equal(restarted.length, 1);
  assert.match(restarted[0]!, new RegExp(`^restart ${CHAT} \\[check-in\\] Your last turn failed at .* Re-check the board and continue\\. \\(abort\\)$`));
  assert.deepEqual(asked, [`${CHAT} anthropic`, `${CHAT} anthropic`, `${CHAT} anthropic`]);
  chats.close();
});

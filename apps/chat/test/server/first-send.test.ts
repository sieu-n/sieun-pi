/**
 * A conversation's turns read the same on every page read, whatever older page was read between them: the server scans the conversation
 * for its earliest speaking call once, and from then on draws each page by that call. Before, a read of an older page that held an earlier
 * call turned the newer page's bubbles into private notes, and a page the browser kept no longer matched the next read. A work thread's
 * live turn also goes to the socket with each step that lands, so a page kept from the socket holds the steps the next read brings.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/first-send.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock } from "../../server/host/types.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../../web/src/lib/api/types.ts";
import { TELL_OWNER_HELD } from "../../web/src/lib/api/shared/chat-feed.ts";
import type { EntryRecord } from "../../server/host/types.ts";
import { Store } from "../../server/store.ts";
import { Threads, type ThreadEvents } from "../../server/threads.ts";
import { buildItems } from "../../server/timeline.ts";
import { start, type Running } from "./helpers.ts";

type Turn = Extract<Item, { kind: "turn" }>;
type FakeThread = Parameters<FixtureHost["append"]>[0];
const turns = (items: readonly Item[]): Turn[] => items.filter((i): i is Turn => i.kind === "turn");

let s: Running;
let host: FixtureHost;
before(async () => {
  s = await start({ wordMs: 2 });
  host = s.host as FixtureHost;
});
after(async () => {
  await s.close();
});

test("an older page's speaking call changes no page read after the scan", async () => {
  const id = ((await s.send("POST", "/api/agents", { name: "scan desk" })).body as { thread: string }).thread;
  const thread = host.threadsById.get(id)!;
  const at = Date.now();
  const say = (text: string) => host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: at }] });
  const answer = (...content: ContentBlock[]) => host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp: at }] });
  say("is the relay up?");
  answer({ type: "toolCall", id: "s1", name: "send_message", arguments: { text: "The relay is up." } });
  host.append(thread, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "s1", toolName: "send_message", content: [{ type: "text", text: "Sent." }], isError: false, timestamp: at }] });
  // Quiet turns past one page, so the newest page holds no speaking call of its own.
  for (let n = 0; n < 40; n++) {
    say(`[check-in ${n}]`);
    answer({ type: "text", text: `Nothing changed at ${n}.` });
  }

  await s.get<TimelinePage>(`/api/c/${id}/items`);
  await s.app.threads.scansDone();
  const first = await s.get<TimelinePage>(`/api/c/${id}/items`);
  assert.ok(first.older, "the conversation runs past one page");
  await s.get<TimelinePage>(`/api/c/${id}/items?before=${first.older}`);
  const again = await s.get<TimelinePage>(`/api/c/${id}/items`);
  assert.deepEqual(again.items, first.items);
  // The conversation talks through send_message from its first call on, so a quiet turn's text is a note in its fold.
  const quiet = turns(first.items).at(-1)!;
  assert.equal(quiet.text, "");
  assert.deepEqual(quiet.sent, []);
});

test("a work thread's live turn goes to the socket with each step, so the page it keeps matches the next read", async () => {
  const id = ((await s.send("POST", "/api/agents", { name: "step desk" })).body as { thread: string }).thread;
  const thread = host.threadsById.get(id)!;
  const live = await s.live();
  live.watch(id);
  await live.waitFor(e => e.type === "status" && e.conversation === id);
  const at = Date.now();
  host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "check the relay" }], timestamp: at }] });
  host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "tail relay.log" } }], provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: at }] });
  const pushed = await live.waitFor(e => e.type === "items" && e.conversation === id && turns(e.items).some(t => t.steps.some(step => step.kind === "tool" && step.name === "bash")));
  live.close();
  assert.ok(pushed.type === "items");
  const page = await s.get<TimelinePage>(`/api/c/${id}/items`);
  assert.deepEqual(turns(pushed.items).at(-1)!.steps, turns(page.items).at(-1)!.steps);
});

const ask = (thread: FakeThread, text: string) => host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] });
const reply = (thread: FakeThread, ...content: ContentBlock[]) =>
  host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp: Date.now() }] });
const result = (thread: FakeThread, call: string, text: string, isError: boolean, data?: unknown) =>
  host.append(thread, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: call, toolName: "tell_owner", content: [{ type: "text", text }], isError, timestamp: Date.now() }], ...(data ? { data } : {}) });
/** The d3 recall threads of 11-22: tell_owner, which a work thread lacks, is refused, and the right answer comes as plain text. */
function refusedThenAnswer(thread: FakeThread, answer: string): EntryRecord {
  ask(thread, "where is the staging console?");
  const call = reply(thread, { type: "toolCall", id: "r1", name: "tell_owner", arguments: { text: answer } });
  result(thread, "r1", "<harness>\n[error] Tool tell_owner is not available\n</harness>", true, { diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool tell_owner is not available" }] });
  reply(thread, { type: "text", text: answer });
  return call;
}

test("a refused tell_owner sends nothing, so the turn's final text is its bubble", async () => {
  const id = ((await s.send("POST", "/api/agents", { name: "refused desk" })).body as { thread: string }).thread;
  refusedThenAnswer(host.threadsById.get(id)!, "Port 9444 under /_vent/console.");
  for (const read of [0, 1]) {
    if (read) await s.app.threads.scansDone();
    const turn = turns((await s.get<TimelinePage>(`/api/c/${id}/items`)).items).at(-1)!;
    assert.equal(turn.text, "Port 9444 under /_vent/console.");
    assert.equal(turn.sent, undefined);
  }
  assert.equal(await s.app.threads.firstSend(id, 1), undefined);
});

test("a held tell_owner still counts as a send, so the turn's own text is a note", async () => {
  const id = ((await s.send("POST", "/api/agents", { name: "held desk" })).body as { thread: string }).thread;
  const thread = host.threadsById.get(id)!;
  ask(thread, "is the relay up?");
  reply(thread, { type: "toolCall", id: "h1", name: "tell_owner", arguments: { text: "The relay is up." } });
  result(thread, "h1", `${TELL_OWNER_HELD}: the owner is away.`, false);
  reply(thread, { type: "text", text: "Done." });
  await s.get<TimelinePage>(`/api/c/${id}/items`);
  await s.app.threads.scansDone();
  const turn = turns((await s.get<TimelinePage>(`/api/c/${id}/items`)).items).at(-1)!;
  assert.equal(turn.text, "");
  assert.deepEqual(turn.sent, []);
  assert.ok(turn.steps.some(step => step.kind === "note" && step.text === "Done."));
});

test("a running tell_owner call is the live turn's bubble before its result lands", () => {
  const at = Date.now();
  const entries: EntryRecord[] = [
    { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "is the relay up?" }], timestamp: at }] },
    { id: 2, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "o1", name: "tell_owner", arguments: { text: "The relay is up." } }], stopReason: "toolUse", timestamp: at }] },
  ];
  const owner = { kind: "owner", id: "owner", name: "owner" } as unknown as Principal;
  const ctx = { thread: "t", conversation: 1, agent: owner, principal: () => owner, tree: [], jobStatus: () => "idle" as const };
  assert.deepEqual(turns(buildItems(entries, { ...ctx, running: true })).at(-1)!.sent, ["The relay is up."]);
  // The same call with no result in a turn that is over never ran.
  assert.equal(turns(buildItems(entries, { ...ctx, running: false })).at(-1)!.sent, undefined);
});

test("a first send cached by the version that counted refused calls is scanned again", async () => {
  const id = ((await s.send("POST", "/api/agents", { name: "cached desk" })).body as { thread: string }).thread;
  const call = refusedThenAnswer(host.threadsById.get(id)!, "Port 9444.");
  const dir = mkdtempSync(join(tmpdir(), "first-send-cache-"));
  mkdirSync(join(dir, "cache"));
  writeFileSync(join(dir, "cache", "first-sends.json"), JSON.stringify({ [id]: { to: call.id + 2, first: call.id } }));
  const events = new Proxy({}, { get: () => () => {} }) as ThreadEvents;
  const threads = new Threads(host, new Store(dir), events, "test-box");
  assert.equal(await threads.firstSend(id, 1), undefined);
  rmSync(dir, { recursive: true, force: true });
});

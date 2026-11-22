/**
 * A conversation's turns read the same on every page read, whatever older page was read between them: the server scans the conversation
 * for its earliest speaking call once, and from then on draws each page by that call. Before, a read of an older page that held an earlier
 * call turned the newer page's bubbles into private notes, and a page the browser kept no longer matched the next read.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/first-send.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock } from "../../server/host/types.ts";
import { start, type Running } from "./helpers.ts";

type Turn = Extract<Item, { kind: "turn" }>;
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

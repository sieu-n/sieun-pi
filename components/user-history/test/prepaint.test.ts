// Guards the 10-18 cold loads from Korea (185 ms a round trip, 100 KB/s): the chat page painted nothing for 2.65 s, until app.js and app.css (214 KB packed) had arrived and app.js ran, so the shell now carries the chat as HTML that paints first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { compileClient, compileServer, loadPrepaint } from "../src/chat-assets.ts";
import { prepaintHtml, prepaintScript, scopeClass } from "../src/prepaint.ts";
import { takeOver } from "../src/client/prepaint-swap.ts";
import { FIRST_ITEMS, windowStart } from "../src/client/feed-window.ts";
import { ACCENTS, APPEARANCE_KEY, DEFAULT_APPEARANCE } from "../src/client/appearance.ts";
import { chatFeed } from "../src/shared/chat-feed.ts";
import { threadStateFromSnapshot } from "../src/shared/thread-state.ts";
import type { ThreadSnapshot } from "../src/shared/types.ts";

const at = Date.UTC(2026, 9, 18, 3, 0);
const messages = Array.from({ length: 24 }, (_, index) => [
  { role: "user", content: `Question ${index} with **bold** and <b>tags</b>`, timestamp: at + index * 20 * 60_000 },
  { role: "assistant", content: [{ type: "text", text: `Answer ${index}\n\n- one\n- two` }], provider: "anthropic", model: "m", stopReason: "stop", timestamp: at + index * 20 * 60_000 + 30_000,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } },
]).flat();
const snapshot = { kind: "live", info: { sessionId: "c1", name: "Fixture <chat>", cwd: "/home/x", isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: messages.length,
  sessionAction: null, queuedActions: 0 }, streaming: null, queue: { steering: [], followUp: [] }, tools: [], retry: null, runStartedAt: null, messages } as unknown as ThreadSnapshot;
const frames = JSON.stringify([{ type: "snapshot", snapshot }]);

test("the server renders the same lines Chat.svelte draws first, inside a frame whose classes app.css styles", async () => {
  const [server, client] = await Promise.all([compileServer(), compileClient()]);
  const prepaint = await loadPrepaint(server);
  assert.ok(prepaint);
  const page = prepaint.prepaintLines("c1", frames);
  assert.ok(page);
  assert.equal(page.title, "Fixture <chat>");
  const feed = chatFeed(threadStateFromSnapshot(snapshot), [], () => undefined);
  const shown = feed.slice(windowStart(feed.map(item => item.id), null, FIRST_ITEMS));
  assert.equal(shown.length, FIRST_ITEMS);
  assert.deepEqual([...page.lines.matchAll(/data-line="([^"]+)"/g)].map(match => match[1]), shown.map(item => item.id));
  assert.ok(page.lines.includes("Question 23 with bold and &lt;b&gt;tags&lt;/b&gt;"));
  assert.ok(page.lines.includes(`data-stamp="${shown[0]!.at}"`));

  const html = prepaintHtml(page);
  assert.ok(/<span class="title [^"]+">Fixture &lt;chat&gt;<\/span>/.test(html));
  const css = Buffer.from(client.css).toString();
  const frame = html.replace(page.lines, "");
  const named = [...frame.matchAll(/class="([^"]+)"/g)].flatMap(match => { const names = match[1]!.split(" "); const scope = names.find(name => name.startsWith("svelte-")); return scope ? names.filter(name => name !== scope && name !== "open").map(name => `.${name}.${scope}`) : []; });
  assert.ok(named.length >= 15, named.join(" "));
  for (const selector of named) assert.ok(css.includes(selector), `app.css has no ${selector}`);
  assert.ok(css.includes(`.line.${scopeClass("src/client/ChatLines.svelte")}`));
  assert.equal(prepaint.prepaintLines("c1", JSON.stringify([{ type: "snapshot", snapshot: { ...snapshot, messages: [] } }])), null);
});

test("the still view goes only on the frame after the app shows the chat's lines", () => {
  const observers: Array<{ callback: () => void; observing: boolean }> = [];
  (globalThis as Record<string, unknown>).MutationObserver = class { record = { callback: () => {}, observing: false }; constructor(callback: () => void) { this.record.callback = callback; observers.push(this.record); } observe() { this.record.observing = true; } disconnect() { this.record.observing = false; } };
  (globalThis as Record<string, unknown>).document = { documentElement: { dataset: { prepaintBoard: "" } } };
  let lines = false;
  let removed = false;
  const frames: Array<() => void> = [];
  const app = { querySelector: () => (lines ? {} : null) } as unknown as Element;
  takeOver({ remove: () => { removed = true; } } as unknown as Element, app, run => frames.push(run));
  assert.equal(observers[0]!.observing, true);
  observers[0]!.callback();
  assert.equal(frames.length, 0);
  lines = true;
  observers[0]!.callback();
  assert.equal(observers[0]!.observing, false);
  assert.equal(removed, false);
  frames[0]!();
  assert.equal(removed, true);
});

test("the still view's script reads the same saved keys and limits as the app", () => {
  const ui = readFileSync(new URL("../src/client/ui.svelte.ts", import.meta.url), "utf8");
  for (const fact of ["SIDEBAR_MIN = 180", "SIDEBAR_MAX = 480", "BOARD_MIN = 280", "BOARD_DEFAULT = 320", '"chat.sidebarWidth")) || 260', 'stored("chat.boardOpen") !== "0"', '"chat.boardWidth"', "window.innerWidth) * 0.6"]) assert.ok(ui.includes(fact), fact);
  assert.ok(prepaintScript.includes(JSON.stringify(APPEARANCE_KEY)));
  assert.ok(prepaintScript.includes(JSON.stringify(ACCENTS.filter(accent => accent !== DEFAULT_APPEARANCE.accent))));
  const style = new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => style.set(key, value) } };
  const stamp = { textContent: "", getAttribute: () => String(at) };
  const scroller = { scrollTop: 0, scrollHeight: 900 };
  const saved: Record<string, string> = { "chat.appearance": '{"theme":"dark","accent":"green"}', "chat.sidebarWidth": "900", "chat.boardWidth": "300" };
  runInNewContext(prepaintScript, { innerWidth: 1440, Number, Math, JSON, Date, localStorage: { getItem: (key: string) => saved[key] ?? null },
    document: { documentElement: root, getElementById: () => ({ querySelectorAll: () => [stamp], querySelector: () => scroller }) } });
  assert.deepEqual(root.dataset, { theme: "dark", accent: "green", prepaintBoard: "" });
  assert.equal(style.get("--prepaint-sidebar"), "480px");
  assert.equal(style.get("--prepaint-board"), "300px");
  assert.notEqual(stamp.textContent, "");
  assert.equal(scroller.scrollTop, 900);
});

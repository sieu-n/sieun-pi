// Guards the empty bullet for a bold label plus a job: link in a list item (owner screenshot 2026-10-18 05:44Z): the server clipped tell_owner text to 400 characters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageStore, Projector } from "../src/chat-projection.ts";
import { mentionIndex } from "../src/client/board.ts";
import { bubbleBlocks, renderMarkdown } from "../src/client/markdown.ts";
import { type ChatLine, chatLines } from "../src/shared/chat-feed.ts";

/** The 626-character tell_owner text from 2026-10-18 05:29Z. Cut at 400 it ended in "- *", which marked draws as an empty bullet with an empty nested one. */
const TOLD = "This chat now runs on the server too, so all 11 have moved. The restore also finished: every file the earlier copy deleted on the server is back, with nothing missing.\n\nTwo problems showed up right after:\n- **Stopped jobs:** the move stopped my running jobs, and the server can't resume them by id yet. So I restarted all 6 fresh. Each one reads its old transcript and picks up where it left off.\n- **Token errors:** 8 of the moved chats show \"couldn't get an API key\" on their last turn, even though 5 accounts are available. [box token errors](job:box token errors) is finding why, and then restarts every chat that stopped.";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const projected = (name: string, args: Record<string, unknown>) => new Projector(new ImageStore()).assistant({
  role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: 1792301347107, usage,
  content: [{ type: "toolCall", id: "toolu_1", name, arguments: args }],
} as Parameters<Projector["assistant"]>[0]);

test("a long tell_owner text reaches the bubble whole, with its bold labels, sentences and job link", () => {
  const agent = chatLines([projected("tell_owner", { text: TOLD, reply_to: "mvdcskw5" })])
    .find((line): line is Extract<ChatLine, { kind: "agent" }> => line.kind === "agent");
  assert.ok(agent);
  assert.equal(agent.text, TOLD);
  const index = mentionIndex("chat-1", null, ["box token errors"]);
  const html = bubbleBlocks(agent.text).map(block => renderMarkdown(block.text, "", index, true)).join("");
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]!);
  assert.equal(items.length, 2, html);
  assert.match(items[0]!, /^Stopped jobs: the move stopped my running jobs/);
  assert.match(items[1]!, /^Token errors: 8 of the moved chats show &quot;couldn&#39;t get an API key&quot;/);
  assert.match(items[1]!, /<a class="artifact-link"[^>]* data-target="job:box token errors" data-preview-chat="chat-1" data-preview-job="box token errors"[^>]*>[\s\S]*box token errors<\/a> is finding why, and then restarts every chat that stopped\.$/);
  assert.doesNotMatch(html, /<li>\s*<ul>/, "no empty nested bullet");
});

test("other tool arguments stay a 400-character preview", () => {
  const call = projected("ipython", { code: TOLD }).content[0];
  assert.ok(call?.type === "toolCall" && call.truncated === true && call.arguments.code === TOLD.slice(0, 400));
});

/**
 * A search hit says who said it, where and what kind of text it is, and shows the human text (owner request, 2026-10-28: "뭐가 뭔지 좀
 * 구분 좀 해주고"). That day a ⌘K row read `...original\":\"python-httpx\\/0.28.1\",\"vent.attempts\"...` under a generic chat icon:
 * raw tool output ranked first and kept its JSON escapes, and nothing said whose output it was.
 */
import assert from "node:assert/strict";
import { after, before, describe as suite, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { cleanTool, describe, fullText, searchTerms, snippet } from "../../server/search-snippet.ts";
import { start, type Running } from "./helpers.ts";

suite("the text a hit shows", () => {
  const terms = searchTerms("vent");

  test("tool output loses its JSON escapes and punctuation", () => {
    const raw = String.raw`{"log":"{\"user_agent.original\":\"python-httpx\\/0.28.1\",\"vent.attempts\":\"0\",\"vent.caller\":\"unknown\"}"}`;
    assert.equal(cleanTool(raw), "log: user_agent.original: python-httpx/0.28.1, vent.attempts: 0, vent.caller: unknown");
    const shown = describe("pi.tool-result", "tool:bash", raw, terms);
    assert.deepEqual([shown.role, shown.tool], ["tool", "bash"]);
    assert.match(snippet(shown.text, terms), /^log: user_agent\.original: python-httpx\/0\.28\.1, <mark>vent<\/mark>\.attempts: 0/);
  });

  test("an answer shows its own words, and a match only in a tool call's arguments says so", () => {
    const text = 'Vent is up on prod.\nbash {"command":"curl -s https://vent.virev.ai/health"}';
    assert.deepEqual(describe("pi.assistant", "anthropic/claude-opus-5-5", text, terms), { role: "agent", text: "Vent is up on prod." });
    const onlyCall = describe("pi.assistant", "anthropic/claude-opus-5-5", 'Checking now.\nbash {"command":"curl -s https://vent.virev.ai/health"}', terms);
    assert.deepEqual(onlyCall, { role: "tool", tool: "bash", inCall: true, text: "curl -s https://vent.virev.ai/health" });
  });

  test("Prime's notes and the chat's automatic inputs name their sender or read as system notes", () => {
    assert.deepEqual(describe("prime.custom", "prime.custom", "[agent-message from child:vent release driver]\n\nVent promote 16 is green.", terms),
      { role: "agent", from: "vent release driver", text: "Vent promote 16 is green." });
    assert.deepEqual(describe("pi.user", "owner", "[check-in] Check-in: nudged job vent mock mode.", terms), { role: "system", label: "Check-in", text: "Check-in: nudged job vent mock mode." });
    assert.deepEqual(describe("pi.user", "owner", "is vent up?", terms), { role: "owner", text: "is vent up?" });
    assert.deepEqual(describe("agent.message", "c-crawler", "[#pi-cutover · post 3 from Crawler VP] The vent port moved.", terms), { role: "agent", text: "The vent port moved." });
  });

  test("Show more holds up to 2,000 characters from just before the first match, escaped", () => {
    const long = `${"x ".repeat(2000)}the <Vent> line ${"y ".repeat(2000)}`;
    const text = fullText(long, terms);
    assert.ok(text.length < 2100);
    assert.match(text, /^….*the &lt;<mark>Vent<\/mark>&gt; line.*…$/);
  });
});

suite("search hits", () => {
  let s: Running;
  before(async () => { s = await start(); });
  after(() => s.close());

  test("each hit names its role and location, with a job under its parent and archived chats marked", async () => {
    const { hits } = await s.get<SearchResult>("/api/search?q=relay&limit=100");
    assert.ok(hits.every(h => ["owner", "agent", "tool", "system"].includes(h.role)));
    assert.ok(hits.filter(h => h.role === "owner").every(h => h.author.name === "You"));
    const job = hits.find(h => h.conversation.id === `${ids.vent}:14`)!;
    assert.deepEqual(job.conversation.parent, { id: ids.vent, name: "Vent" });
    assert.ok(hits.filter(h => h.conversation.id === ids.archived).every(h => h.conversation.archived));
    const reply = hits.find(h => h.conversation.id === ids.cutoverChannel && h.messageId === "p3")!;
    assert.equal(reply.threadRoot, "p1");
    const call = hits.find(h => h.inCall && h.tool === "bash")!;
    assert.equal(call.role, "tool");
    assert.ok(!call.snippet.includes("{"), call.snippet);
  });

  test("by relevance tool output ranks after every message, and type keeps one side", async () => {
    const all = await s.get<SearchResult>("/api/search?q=relay&limit=100");
    const firstOutput = all.hits.findIndex(h => h.kind === "tool");
    assert.ok(firstOutput > 0);
    assert.ok(all.hits.slice(firstOutput).every(h => h.kind === "tool"));
    const tools = await s.get<SearchResult>("/api/search?q=relay&type=tools&limit=100");
    const messages = await s.get<SearchResult>("/api/search?q=relay&type=messages&limit=100");
    assert.ok(tools.total > 0 && tools.hits.every(h => h.kind === "tool"));
    assert.ok(messages.hits.every(h => h.kind !== "tool"));
    assert.equal(tools.total + messages.total, all.total);
  });

  test("from=agents leaves out what the owner wrote", async () => {
    const all = await s.get<SearchResult>("/api/search?q=relay&limit=100");
    const agents = await s.get<SearchResult>("/api/search?q=relay&from=agents&limit=100");
    const owner = await s.get<SearchResult>("/api/search?q=relay&from=owner&limit=100");
    assert.ok(agents.hits.length > 0 && agents.hits.every(h => h.author.id !== "owner"));
    assert.equal(agents.total + owner.total, all.total);
  });
});

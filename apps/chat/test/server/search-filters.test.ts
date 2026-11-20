/**
 * Search filters for people and agents alike (owner, #sw-factory-build p115: "search에서 filter 직관적으로 할수 있어야됨 (especially for
 * humans, and allow the same filter feature for Agents too) . 일단 큰 소스 (by which agent/user), in root message, in thread, diggen in
 * some internal tool call"). `from` and `where` take many values, names stand in for ids, and every hit says where it sits and links there.
 */
import assert from "node:assert/strict";
import { after, before, describe as suite, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { and, eq, holds, not, type EntryDoc, type PostDoc } from "../../server/search-engine.ts";
import { hitLink, parseQuery, threadTitle } from "../../server/search.ts";
import { start, type Running } from "./helpers.ts";

const ids_ = (result: SearchResult) => result.hits.map(hit => hit.id).sort();

suite("search filters", () => {
  let s: Running;
  before(async () => { s = await start(); });
  after(() => s.close());
  const search = (query: string) => s.get<SearchResult>(`/api/search?q=relay&limit=100&${query}`);

  test("where splits every hit into root, thread and tool, and many values add up", async () => {
    const all = await search("");
    const [root, thread, tool] = await Promise.all([search("where=root"), search("where=thread"), search("where=tool")]);
    assert.ok(root.total > 0 && thread.total > 0 && tool.total > 0);
    assert.equal(root.total + thread.total + tool.total, all.total);
    for (const [where, result] of [["root", root], ["thread", thread], ["tool", tool]] as const) assert.ok(result.hits.every(hit => hit.where === where), where);
    assert.ok(all.hits.filter(hit => hit.kind === "tool").every(hit => hit.where === "tool"));
    const people = await search("where=root,thread");
    assert.equal(people.total, root.total + thread.total);
    assert.deepEqual(ids_(await search("where=root&where=thread")), ids_(people));
    assert.deepEqual(ids_(await search("where=root,thread,tool")), ids_(all));
  });

  test("a root chat's own words are root, and its jobs and every work thread are tool", async () => {
    const words = await s.get<SearchResult>("/api/search?q=clock&where=root&limit=100");
    assert.ok(words.total > 0 && words.hits.every(hit => hit.conversation.id === ids.solo), "the root chat's own words are root");
    const job = await s.get<SearchResult>("/api/search?q=clock&where=tool&limit=100");
    assert.ok(job.total > 0 && job.hits.every(hit => hit.conversation.id.startsWith(`${ids.solo}:`)), "its job's words are inside the work");
    const root = await search("where=root");
    const tool = await search("where=tool");
    assert.ok(tool.hits.some(hit => hit.conversation.id === ids.vent && hit.role !== "tool"), "a work thread's answer is inside the work");
    assert.ok(tool.hits.some(hit => hit.conversation.id === `${ids.vent}:14`), "a job's entries are inside the work");
    assert.ok(!root.hits.some(hit => hit.conversation.kind === "job"));
  });

  test("each hit carries the link that opens it, and a reply names its thread", async () => {
    const all = await search("");
    const reply = all.hits.find(hit => hit.conversation.id === ids.cutoverChannel && hit.messageId === "p3")!;
    assert.equal(reply.where, "thread");
    assert.deepEqual(reply.thread, { root: "p1", title: "@AI harness developer environment VP what still blocks the…" });
    assert.equal(reply.link, "#/c/ch_cutover?thread=p1&m=p3");
    const post = all.hits.find(hit => hit.conversation.id === ids.cutoverChannel && hit.messageId === "p5")!;
    assert.deepEqual([post.where, post.thread, post.link], ["root", undefined, "#/c/ch_cutover?m=p5"]);
    const job = all.hits.find(hit => hit.conversation.id === `${ids.vent}:14`)!;
    assert.equal(job.link, `#/c/${encodeURIComponent(`${ids.vent}:14`)}?m=${job.messageId}`);
    assert.match(job.messageId, /^e\d+$/);
  });

  test("from takes many values as a comma list or repeated, OR-ed, and agent names in any case", async () => {
    const [owner, vent, crawler] = await Promise.all([search("from=owner"), search(`from=${agents.vent}`), search(`from=${agents.crawler}`)]);
    assert.ok(owner.total > 0 && vent.total > 0 && crawler.total > 0);
    const both = await search(`from=owner,${agents.vent}`);
    assert.equal(both.total, owner.total + vent.total);
    assert.deepEqual(ids_(await search(`from=owner&from=${agents.vent}`)), ids_(both));
    assert.deepEqual(ids_(await search("from=Vent")), ids_(vent));
    assert.deepEqual(ids_(await search("from=crawler%20vp")), ids_(crawler));
    assert.deepEqual(ids_(await s.get<SearchResult>("/api/search?q=relay%20from:owner%20from:vent&limit=100")), ids_(both));
  });

  test("from an agent finds its posts, its agent messages and its own work, jobs included", async () => {
    const vent = await search(`from=${agents.vent}`);
    assert.ok(vent.hits.every(hit => hit.author.id !== "owner"));
    assert.ok(vent.hits.some(hit => hit.conversation.id === `${ids.vent}:14`), "its job");
    assert.ok(vent.hits.some(hit => hit.conversation.id === ids.generalChannel && hit.where === "thread"), "its channel reply");
  });

  test("filters combine: from, where and in narrow each other", async () => {
    const agentsReplies = await search("from=agents&where=thread");
    assert.ok(agentsReplies.total > 0 && agentsReplies.hits.every(hit => hit.where === "thread" && hit.author.id !== "owner"));
    const ownerTool = await search("from=owner&where=tool");
    assert.ok(ownerTool.hits.every(hit => hit.where === "tool" && hit.author.id === "owner"));
    const inChannel = await search(`in=${ids.cutoverChannel}&where=thread`);
    assert.ok(inChannel.total > 0 && inChannel.hits.every(hit => hit.conversation.id === ids.cutoverChannel && hit.where === "thread"));
    assert.equal((await search(`in=${ids.cutoverChannel}&where=tool`)).total, 0);
  });

  test("in takes a channel or Solo room name, with or without #, and an agent name for its DM", async () => {
    const channel = await search(`in=${ids.cutoverChannel}`);
    assert.ok(channel.total > 0);
    assert.deepEqual(ids_(await search("in=pi-cutover")), ids_(channel));
    assert.deepEqual(ids_(await search("in=%23PI-Cutover")), ids_(channel));
    const room = await search(`in=${ids.soloRoom}`);
    assert.ok(room.total > 0);
    assert.deepEqual(ids_(await search("in=Relay%20Protocol")), ids_(room));
    assert.deepEqual(ids_(await search("in=vent")), ids_(await search(`in=${agents.vent}`)));
  });

  test("an unknown value is a 400 that names it", async () => {
    for (const [query, word] of [["where=replies", "replies"], ["from=nobody", "nobody"], ["from=owner,nobody", "nobody"], ["in=nowhere", "nowhere"]] as const) {
      const answer = await s.send("GET", `/api/search?q=relay&${query}`);
      assert.equal(answer.status, 400, query);
      assert.match((answer.body as { error: string }).error, new RegExp(`"${word}"`), query);
    }
  });

  test("a reply that just landed is found by where before Meilisearch has it", async () => {
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "zanzibar relay reply", requestId: "filters-reply", threadRoot: "p1" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const thread = await s.get<SearchResult>("/api/search?q=zanzibar&where=thread");
    assert.equal(thread.total, 1);
    assert.deepEqual([thread.hits[0]!.where, thread.hits[0]!.thread?.root], ["thread", "p1"]);
    assert.equal((await s.get<SearchResult>("/api/search?q=zanzibar&where=root")).total, 0);
  });
});

suite("the pieces filters are built from", () => {
  const reply = { id: "p_ch_p9", source: "post", kind: "room.reply", text: "x", reactions: "", at: 1, tier: 0, author: "owner", room: "ch", post: "p9", dm: false, listed: true, ownerPost: true } satisfies PostDoc;
  const entry = { id: "e1_x", source: "entry", text: "x", at: 1, tier: 0, kind: "pi.user", author: "owner", entry: 1, threads: ["t"], convs: ["t:1"], keys: ["t:1"], channelCopy: false } satisfies EntryDoc;

  test("a pending document meets the where filter in memory as Meilisearch reads it", () => {
    assert.ok(holds(and(eq("source", "post"), eq("kind", "room.reply")), reply));
    assert.ok(!holds(not(eq("kind", "room.reply")), reply));
    // A document with no kind of a post, as one indexed before posts had it, is a top-level post, as `NOT (kind = ...)` reads it.
    const { kind: _kind, ...bare } = reply;
    assert.ok(holds(not(eq("kind", "room.reply")), bare as unknown as PostDoc));
    assert.ok(holds(not(eq("kind", "room.reply")), entry));
  });

  test("from: tokens add values, and explicit params win", () => {
    assert.deepEqual(parseQuery({ q: "relay from:owner from:vent,crawler" }).from, ["owner", "vent", "crawler"]);
    assert.deepEqual(parseQuery({ q: "relay from:owner", from: ["agents"] }).from, ["agents"]);
  });

  test("links and thread titles", () => {
    assert.equal(hitLink("t:3", "e9"), "#/c/t%3A3?m=e9");
    assert.equal(hitLink("ch_x", "p4", "p1"), "#/c/ch_x?thread=p1&m=p4");
    assert.equal(threadTitle("**Ship** the `relay`\n\nnow"), "Ship the relay now");
  });
});

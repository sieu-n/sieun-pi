/**
 * Search filters for people and agents alike (owner, #sw-factory-build p115: "search에서 filter 직관적으로 할수 있어야됨 (especially for
 * humans, and allow the same filter feature for Agents too) . 일단 큰 소스 (by which agent/user), in root message, in thread, diggen in
 * some internal tool call"). `from` and `place` take many values, names stand in for ids, and every hit says where it sits and links there.
 */
import assert from "node:assert/strict";
import { after, before, describe as suite, test } from "node:test";
import type { SearchHit, SearchPlace, SearchResult } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { and, eq, holds, not, type EntryDoc, type PostDoc } from "../../server/search-engine.ts";
import { hitLink, parseHas, parseQuery, SEARCH_PLACES, threadTitle } from "../../server/search.ts";
import { describe, indexedAuthor } from "../../server/search-snippet.ts";
import { start, type Running } from "./helpers.ts";

const ids_ = (result: SearchResult) => result.hits.map(hit => hit.id).sort();

suite("search filters", () => {
  let s: Running;
  before(async () => { s = await start(); });
  after(() => s.close());
  const search = (query: string) => s.get<SearchResult>(`/api/search?q=relay&limit=100&${query}`);

  test("each hit's where is root, thread or tool, and the places of each add up", async () => {
    const all = await search("");
    const [root, thread, tool] = await Promise.all([search("place=channels,dms,solo"), search("place=threads"), search("place=jobs,tools")]);
    assert.ok(root.total > 0 && thread.total > 0 && tool.total > 0);
    assert.equal(root.total + thread.total + tool.total, all.total);
    for (const [where, result] of [["root", root], ["thread", thread], ["tool", tool]] as const) assert.ok(result.hits.every(hit => hit.where === where), where);
    assert.ok(all.hits.filter(hit => hit.kind === "tool").every(hit => hit.where === "tool"));
    const people = await search("place=channels,dms,solo,threads");
    assert.equal(people.total, root.total + thread.total);
  });

  test("a root chat's own words are root, and its jobs and every work thread are tool", async () => {
    const words = await s.get<SearchResult>("/api/search?q=clock&place=channels,dms,solo&limit=100");
    assert.ok(words.total > 0 && words.hits.every(hit => hit.conversation.id === ids.solo), "the root chat's own words are root");
    const job = await s.get<SearchResult>("/api/search?q=clock&place=jobs,tools&limit=100");
    assert.ok(job.total > 0 && job.hits.every(hit => hit.conversation.id.startsWith(`${ids.solo}:`)), "its job's words are inside the work");
    const root = await search("place=channels,dms,solo");
    const tool = await search("place=jobs,tools");
    assert.ok(tool.hits.some(hit => hit.conversation.id === ids.vent && hit.role !== "tool"), "a work thread's answer is inside the work");
    assert.ok(tool.hits.some(hit => hit.conversation.id === `${ids.vent}:14`), "a job's entries are inside the work");
    assert.ok(!root.hits.some(hit => hit.conversation.kind === "job"));
  });

  test("place splits every hit into six places, OR-ed within, AND-ed with in and from", async () => {
    // "quiet" keeps Vent from answering: its two answers landed 260 to 700 ms after the send, in the middle of this test on a loaded box.
    const dm = await s.send("POST", "/api/c/dm_vent/send", { text: "quiet: is the relay up in the DM too", requestId: "filters-place-dm" });
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    const all = await search("");
    const by = Object.fromEntries(await Promise.all(SEARCH_PLACES.map(async place => [place, await search(`place=${place}`)] as const)));
    const fits: Record<SearchPlace, (hit: SearchHit) => boolean> = {
      channels: hit => hit.where === "root" && hit.conversation.kind === "channel",
      dms: hit => hit.where === "root" && hit.conversation.kind === "dm",
      solo: hit => hit.where === "root" && hit.conversation.kind === "solo",
      threads: hit => hit.where === "thread",
      jobs: hit => hit.where === "tool" && hit.kind !== "tool",
      tools: hit => hit.kind === "tool",
    };
    for (const place of SEARCH_PLACES) {
      assert.ok(by[place]!.total > 0, place);
      assert.ok(by[place]!.hits.every(fits[place]), place);
    }
    assert.equal(SEARCH_PLACES.reduce((sum, place) => sum + by[place]!.total, 0), all.total);
    assert.ok(by.solo!.hits.some(hit => hit.conversation.id === ids.soloRoom), "a Solo room's posts");
    const words = await s.get<SearchResult>("/api/search?q=clock&place=solo&limit=100");
    assert.deepEqual(ids_(words), ids_(await s.get<SearchResult>("/api/search?q=clock&place=channels,dms,solo&limit=100")), "a root chat's words");
    const mix = await search("place=jobs,threads");
    assert.equal(mix.total, by.jobs!.total + by.threads!.total);
    assert.deepEqual(ids_(await search("place=jobs&place=threads")), ids_(mix));
    assert.deepEqual(ids_(await search("place=Job,THREAD")), ids_(mix));
    assert.deepEqual(ids_(await s.get<SearchResult>("/api/search?q=relay%20place:jobs%20place:threads&limit=100")), ids_(mix));
    assert.deepEqual(ids_(await search("place=tool%20calls")), ids_(by.tools!));
    assert.deepEqual(ids_(await search("place=channels,dms,solo,threads,jobs,tools")), ids_(all));
    assert.equal((await search(`in=${ids.cutoverChannel}&place=solo,dms`)).total, 0);
    const ownerJobs = await search("from=owner&place=jobs");
    assert.ok(ownerJobs.hits.every(hit => fits.jobs(hit) && hit.author.id === "owner"));
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

  test("filters combine: from, place and in narrow each other", async () => {
    const agentsReplies = await search("from=agents&place=threads");
    assert.ok(agentsReplies.total > 0 && agentsReplies.hits.every(hit => hit.where === "thread" && hit.author.id !== "owner"));
    const ownerTool = await search("from=owner&place=jobs,tools");
    assert.ok(ownerTool.hits.every(hit => hit.where === "tool" && hit.author.id === "owner"));
    const inChannel = await search(`in=${ids.cutoverChannel}&place=threads`);
    assert.ok(inChannel.total > 0 && inChannel.hits.every(hit => hit.conversation.id === ids.cutoverChannel && hit.where === "thread"));
    assert.equal((await search(`in=${ids.cutoverChannel}&place=jobs,tools`)).total, 0);
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

  test("in takes a job's name as a hit shows it, so an agent scopes to a job the way it reads it", async () => {
    const id = `${ids.vent}:14`;
    const job = (await search("")).hits.find(hit => hit.conversation.id === id)!;
    const byId = await search(`in=${encodeURIComponent(id)}`);
    assert.ok(byId.total > 0);
    assert.deepEqual(ids_(await search(`in=${encodeURIComponent(job.conversation.name.toUpperCase())}`)), ids_(byId));
  });

  test("an unknown value is a 400 that names it", async () => {
    for (const [query, word] of [["place=inbox", "inbox"], ["place=jobs,nowhere", "nowhere"], ["from=nobody", "nobody"], ["from=owner,nobody", "nobody"], ["in=nowhere", "nowhere"]] as const) {
      const answer = await s.send("GET", `/api/search?q=relay&${query}`);
      assert.equal(answer.status, 400, query);
      assert.match((answer.body as { error: string }).error, new RegExp(`"${word}"`), query);
    }
  });

  test("a reply that just landed is found by place before Meilisearch has it", async () => {
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "zanzibar relay reply", requestId: "filters-reply", threadRoot: "p1" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const thread = await s.get<SearchResult>("/api/search?q=zanzibar&place=threads");
    assert.equal(thread.total, 1);
    assert.deepEqual([thread.hits[0]!.where, thread.hits[0]!.thread?.root], ["thread", "p1"]);
    assert.equal((await s.get<SearchResult>("/api/search?q=zanzibar&place=channels,dms,solo")).total, 0);
  });

  test("a filter with no words lists every message it keeps, newest first, and no filter and no words list nothing", async () => {
    const vent = await s.get<SearchResult>(`/api/search?q=&from=${agents.vent}&limit=100`);
    assert.ok(vent.total > 0 && vent.hits.length > 0);
    assert.ok(vent.hits.every(hit => hit.author.id !== "owner"));
    assert.deepEqual(vent.hits.map(hit => hit.at), [...vent.hits.map(hit => hit.at)].sort((a, b) => b - a), "newest first");
    const room = await s.get<SearchResult>(`/api/search?in=${ids.cutoverChannel}&sort=relevance&limit=100`);
    assert.ok(room.total > 0 && room.hits.every(hit => hit.conversation.id === ids.cutoverChannel));
    assert.deepEqual(await s.get<SearchResult>("/api/search?q=&limit=100"), { hits: [], total: 0 });
  });

  test("has keeps room posts with a link, a reaction or a save, AND-ed, and no thread entry", async () => {
    const send = async (text: string, requestId: string) => {
      const sent = await s.send<{ item: { id: string } }>("POST", `/api/c/${ids.cutoverChannel}/send`, { text, requestId });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      return s.app.agentStore.postsOf(ids.cutoverChannel).find(post => post.requestId === requestId)!;
    };
    const linked = await send("the wombat notes are at https://example.com/wombat", "has-link");
    const reacted = await send("wombat with a reaction", "has-reaction");
    await send("wombat with nothing", "has-none");
    assert.equal((await s.send("POST", `/api/c/${ids.cutoverChannel}/posts/${reacted.id}/reactions`, { emoji: "+1" })).status, 200);
    assert.equal((await s.send("POST", "/api/later", { room: ids.cutoverChannel, post: linked.id })).status, 200);
    assert.equal((await s.send("POST", `/api/c/${ids.cutoverChannel}/posts/${reacted.id}/pin`, { pinned: true })).status, 200);
    // The fixture's agents answer in the channel with the words of the post, so only the owner's posts are counted.
    const posts = (query: string) => s.get<SearchResult>(`/api/search?${query}&from=owner&limit=100`).then(result => result.hits.map(hit => hit.messageId).sort());
    assert.deepEqual(await posts("q=wombat&has=link"), [linked.id]);
    assert.deepEqual(await posts("q=wombat%20has:reaction"), [reacted.id]);
    assert.deepEqual(await posts("q=wombat&has=saved"), [linked.id]);
    assert.deepEqual(await posts("q=wombat%20is:saved%20has:link"), [linked.id]);
    assert.deepEqual(await posts("q=wombat&has=saved,reaction"), []);
    assert.deepEqual(await posts("q=wombat%20is:pinned"), [reacted.id]);
    assert.equal((await s.send("POST", `/api/c/${ids.cutoverChannel}/posts/${reacted.id}/pin`, { pinned: false })).status, 200);
    assert.deepEqual(await posts("q=wombat&has=pin"), [], "an un-pinned post leaves has:pin");
    assert.ok((await s.get<SearchResult>("/api/search?has=link&limit=100")).hits.every(hit => hit.kind === "post"), "a filter with no words");
    assert.equal((await s.send("GET", "/api/search?q=wombat&has=file")).status, 400);
  });

  test("a duty push the chat typed as the owner's turn is no word of his, and from=agents leaves it out too", async () => {
    const pushed = await s.send("POST", `/api/c/${ids.solo}/send`, { text: "[d9 push 2026-10-23T04:07Z] quokka found in your chat", requestId: "filters-push" });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    const said = await s.send("POST", `/api/c/${ids.solo}/send`, { text: "does the quokka still show", requestId: "filters-said" });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    const all = await s.get<SearchResult>("/api/search?q=quokka");
    const push = all.hits.find(hit => hit.kind === "message" && hit.snippet.includes("found in your chat"))!;
    assert.deepEqual([push.role, push.author.kind, push.author.name], ["system", "system", "Duty"]);
    const owner = await s.get<SearchResult>("/api/search?q=quokka&from=owner");
    assert.deepEqual(owner.hits.map(hit => hit.role), ["owner"]);
    const agentsSaid = await s.get<SearchResult>("/api/search?q=quokka&from=agents");
    assert.ok(agentsSaid.total > 0 && agentsSaid.hits.every(hit => hit.role === "agent"), "the echo turns, and no push");
  });
});

suite("the pieces filters are built from", () => {
  const reply = { id: "p_ch_p9", source: "post", kind: "room.reply", text: "x", reactions: "", at: 1, tier: 0, author: "owner", room: "ch", post: "p9", dm: false, listed: true, ownerPost: true, has: ["link"] } satisfies PostDoc;
  const entry = { id: "e1_x", source: "entry", text: "x", at: 1, tier: 0, kind: "pi.user", author: "owner", entry: 1, threads: ["t"], convs: ["t:1"], keys: ["t:1"], channelCopy: false } satisfies EntryDoc;

  test("a pending document meets the where filter in memory as Meilisearch reads it", () => {
    assert.ok(holds(and(eq("source", "post"), eq("kind", "room.reply")), reply));
    assert.ok(!holds(not(eq("kind", "room.reply")), reply));
    // A document with no kind of a post, as one indexed before posts had it, is a top-level post, as `NOT (kind = ...)` reads it.
    const { kind: _kind, ...bare } = reply;
    assert.ok(holds(not(eq("kind", "room.reply")), bare as unknown as PostDoc));
    assert.ok(holds(not(eq("kind", "room.reply")), entry));
  });

  test("has: and is: tokens become marks, and is:thread the Threads place", () => {
    const parsed = parseQuery({ q: "relay has:link is:saved is:thread has:reaction,pin" });
    assert.deepEqual([parsed.q, parsed.has, parsed.place], ["relay", ["link", "saved", "reaction", "pin"], ["threads"]]);
    assert.deepEqual([...parseHas(["Links", "pinned", "reactions", "saved"])], ["link", "pin", "reaction", "saved"]);
    assert.throws(() => parseHas(["file"]), /No has value "file"/);
    assert.ok(holds(eq("has", "link"), reply) && !holds(eq("has", "pin"), reply));
  });

  test("from: tokens add values, and explicit params win", () => {
    assert.deepEqual(parseQuery({ q: "relay from:owner from:vent,crawler" }).from, ["owner", "vent", "crawler"]);
    assert.deepEqual(parseQuery({ q: "relay from:owner", from: ["agents"] }).from, ["agents"]);
  });

  test("an owner turn the chat or Prime wrote is indexed under system, and his own words under owner", () => {
    assert.equal(indexedAuthor("pi.user", "owner", "[d9 push 2026-10-23T04:07Z] The chat system duty (d9) found these"), "system");
    assert.equal(indexedAuthor("pi.user", "owner", "[check-in] Keep going"), "system");
    assert.equal(indexedAuthor("pi.user", "owner", "does 5174 connect to local Convex?"), "owner");
    assert.equal(indexedAuthor("pi.user", "ag_vent", "[check-in] Keep going"), "ag_vent");
    assert.deepEqual(describe("pi.user", "system", "[duty d1] relay is down", []), { role: "system", label: "Duty", text: "relay is down" });
  });

  test("links and thread titles", () => {
    assert.equal(hitLink("t:3", "e9"), "#/c/t%3A3?m=e9");
    assert.equal(hitLink("ch_x", "p4", "p1"), "#/c/ch_x?thread=p1&m=p4");
    assert.equal(threadTitle("**Ship** the `relay`\n\nnow"), "Ship the relay now");
  });
});

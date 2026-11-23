/**
 * Channels and Solo rooms on the fixture host (server/group-rooms.ts, apps/chat/docs/agent-model.md phase 5): every post reaches each member
 * it wakes in that member's comm thread for the room, never its work thread; an agent's post is delivered on with one more hop, and the 6-hop
 * cap stops a loop; a closed room takes no post and delivers nothing until it is reopened; and a comm thread's speaking call becomes one
 * room post across re-reads and a restart. The last spec runs sequence (d) end to end on the fixture's answering agents.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/group-rooms.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentConfig, ConversationHeader, Item, LiveEvent, Room, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { MAX_HOPS } from "../../server/group-rooms.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids, seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, SubmitInput } from "../../server/host/types.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
/** Every agenda here says "quiet", which the fixture's agents read as a turn that sends nothing, so only the spec speaks for them. */
const QUIET = "quiet: pick the relay protocol";
const posts = async (s: Running, room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
const commOf = (s: Running, agent: string, room: string): string | undefined => s.app.agents.record(agent)!.comm?.[room];
const stored = (s: Running, room: string) => s.app.agentStore.postsOf(room);

/** A tell_owner call and its result in conversation 1 of `thread`, with `reply_to` when given. */
function told(host: FixtureHost, thread: string, id: string, text: string, replyTo?: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer", ...(replyTo ? { reply_to: replyTo } : {}) } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

/** An agent message from `from`, as a delivery of `post` in `room` at `hops`, typed straight into a comm thread. */
function delivered(host: FixtureHost, thread: string, from: string, room: string, post: string, hops: number): void {
  host.append(host.threadsById.get(thread)!, 1, {
    kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: `[test · post ${post.slice(1)} from x · hops ${hops}]\n\nquiet` }], timestamp: Date.now() }],
    data: { from, via: room },
  });
}

describe("a Solo room", () => {
  let s: Running;
  let host: FixtureHost;
  let room: Room;
  const submits: { thread: string; input: SubmitInput }[] = [];
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
  });
  after(async () => {
    await s.close();
  });
  const roomSubmits = () => submits.filter(x => x.input.requestId?.startsWith(`d:${room.id}:`));

  test("its agenda is the owner's first post, delivered to both members' comm threads as the owner's turn and never to a work thread", async () => {
    const workEntries = [ids.vent, ids.frontend].map(id => host.threadsById.get(id)!.entries.length);
    const created = await s.send("POST", "/api/rooms", { kind: "solo", agenda: QUIET, members: [agents.vent, "frontend bro"] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    room = created.body;
    assert.match(room.id, /^so_[0-9a-f]{8}$/);
    assert.equal(room.name, QUIET);
    assert.deepEqual(room.members.map(m => [m.principal.id, m.role, m.wakeOn]), [["owner", "owner", "all"], [agents.vent, "member", "all"], [agents.frontend, "member", "all"]]);

    await until(async () => roomSubmits().length, n => n === 2);
    const ventComm = commOf(s, agents.vent, room.id)!;
    const frontComm = commOf(s, agents.frontend, room.id)!;
    assert.equal(host.threadsById.get(ventComm)!.row.name, `Vent · Solo ${QUIET}`);
    assert.equal(host.threadsById.get(frontComm)!.row.thinkingLevel, "high");
    const header = `[Solo "${QUIET}" (${room.id}): ${QUIET} · with Vent, frontend bro · post 1 from You (owner) · hops 0]`;
    assert.deepEqual(roomSubmits().map(x => [x.thread, x.input.requestId, x.input.ownerTurn, x.input.whenBusy, x.input.text]).sort(), [
      [ventComm, `d:${room.id}:p1:${agents.vent}`, true, "steer", `${header}\n\n${QUIET}`],
      [frontComm, `d:${room.id}:p1:${agents.frontend}`, true, "steer", `${header}\n\n${QUIET}`],
    ].sort());
    assert.deepEqual([ids.vent, ids.frontend].map(id => host.threadsById.get(id)!.entries.length), workEntries, "the work threads get no input");
    assert.equal(host.threadsById.get(ventComm)!.entries.find(e => e.kind === "pi.user")?.kind, "pi.user");

    const page = await until(() => posts(s, room.id), p => p[0]!.deliveries.every(d => d.state === "delivered"));
    assert.deepEqual(page.map(p => [p.author.id, p.text]), [["owner", QUIET]]);

    const head = await s.get<ConversationHeader>(`/api/c/${room.id}`);
    assert.equal(head.agenda, QUIET);
    assert.deepEqual(head.boards, [agents.vent, agents.frontend]);
    assert.equal(head.closedAt, undefined);
    assert.equal(head.summary.kind, "solo");
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.equal(sidebar.solo[0]!.id, room.id, "an open Solo room leads the Solo group");
    const agent = (await s.get<{ id: string; rooms: string[] }[]>("/api/agents")).find(a => a.id === agents.vent)!;
    assert.ok(agent.rooms.includes(room.id));
  });

  test("an agent's post is delivered on to the other member with one more hop, and a post at hops 6 is stopped", async () => {
    const ventComm = commOf(s, agents.vent, room.id)!;
    const frontComm = commOf(s, agents.frontend, room.id)!;
    const before = roomSubmits().length;
    told(host, ventComm, "v1", "WebSocket per box, quiet otherwise.");
    await s.app.groups.feed(ventComm);
    const p2 = stored(s, room.id).find(p => p.requestId === `m:${ventComm}:v1`)!;
    assert.equal(p2.author, agents.vent);
    assert.equal(p2.hops, 1);
    assert.deepEqual(p2.deliveries?.map(d => d.target), [agents.frontend], "its author is not woken");
    await until(async () => roomSubmits().length, n => n === before + 1);
    const sent = roomSubmits().at(-1)!;
    assert.equal(sent.thread, frontComm);
    assert.equal(sent.input.whenBusy, "followUp");
    assert.equal(sent.input.ownerTurn, undefined);
    assert.deepEqual(sent.input.entry, { kind: "agent.message", data: { from: agents.vent, via: room.id } });
    assert.match(sent.input.text!, new RegExp(`· post ${p2.seq} from Vent · hops 1\\]\\n\\nWebSocket per box`));

    // frontend bro's turn on that post speaks: its post carries hops 2 and wakes Vent.
    await until(async () => host.threadsById.get(frontComm)!.entries.filter(e => e.kind === "agent.message").length, n => n === 1);
    told(host, frontComm, "f1", "Fine, quiet from me.");
    await s.app.groups.feed(frontComm);
    const p3 = stored(s, room.id).find(p => p.requestId === `m:${frontComm}:f1`)!;
    assert.equal(p3.hops, 2);
    assert.deepEqual(p3.deliveries?.map(d => d.target), [agents.vent]);

    // A turn on a post five hops from the owner makes a post at hops 6, which reaches no one.
    delivered(host, frontComm, agents.vent, room.id, p2.id, MAX_HOPS - 1);
    told(host, frontComm, "f2", "Sixth hop, quiet.");
    await s.app.groups.feed(frontComm);
    const p4 = stored(s, room.id).find(p => p.requestId === `m:${frontComm}:f2`)!;
    assert.equal(p4.hops, MAX_HOPS);
    assert.deepEqual(p4.deliveries?.map(d => [d.target, d.state]), [[agents.vent, "stopped"]]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!submits.some(x => x.input.requestId === `d:${room.id}:${p4.id}:${agents.vent}`), "a stopped delivery is never submitted");
    const item = (await posts(s, room.id)).find(p => p.id === p4.id)!;
    assert.equal(item.deliveries[0]!.state, "stopped");
    assert.match(item.deliveries[0]!.error!, /Stopped after 6/);

    // The owner's next post starts again at hops 0.
    const owner = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, new question", requestId: "solo-owner-2" });
    assert.equal(stored(s, room.id).find(p => p.id === owner.body.item.id)!.hops, 0);
  });

  test("a closed room refuses the owner's post and delivers nothing; reopened, it takes posts again", async () => {
    const ventComm = commOf(s, agents.vent, room.id)!;
    const closed = await s.send("PATCH", `/api/rooms/${room.id}`, { closed: true });
    assert.equal(closed.status, 200);
    assert.equal(typeof closed.body.closedAt, "number");
    const refused = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, are you there?", requestId: "solo-closed-1" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /reopen/);
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.equal(typeof sidebar.solo.find(c => c.id === room.id)!.closedAt, "number");
    assert.equal((await s.get<ConversationHeader>(`/api/c/${room.id}`)).closedAt, closed.body.closedAt);

    const before = roomSubmits().length;
    told(host, ventComm, "v_closed", "Said after the close, quiet.");
    await s.app.groups.feed(ventComm);
    const late = stored(s, room.id).find(p => p.requestId === `m:${ventComm}:v_closed`)!;
    assert.deepEqual(late.deliveries, [], "an agent post in a closed room is stored with no deliveries");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(roomSubmits().length, before);

    const reopened = await s.send("PATCH", `/api/rooms/${room.id}`, { closed: false });
    assert.equal(reopened.body.closedAt, undefined);
    const sent = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, back again", requestId: "solo-reopen-1" });
    assert.equal(sent.status, 200);
    await until(async () => roomSubmits().length, n => n === before + 2);
    assert.equal((await s.send("PATCH", `/api/rooms/${ids.cutoverChannel}`, { closed: true })).status, 400, "a channel is archived, not closed");
  });

  test("members come and go, and only a registered agent joins", async () => {
    const added = await s.send("POST", `/api/rooms/${room.id}/members`, { agents: [agents.crawler] });
    assert.deepEqual(added.body.members.map((m: { principal: { id: string }; wakeOn: string }) => [m.principal.id, m.wakeOn]).slice(1), [
      [agents.vent, "all"], [agents.frontend, "all"], [agents.crawler, "all"],
    ]);
    assert.equal((await s.send("POST", `/api/rooms/${room.id}/members`, { agents: [ids.cutover] })).status, 400);
    const removed = await s.send("DELETE", `/api/rooms/${room.id}/members/${agents.crawler}`);
    assert.equal(removed.body.members.length, 3);
    assert.ok((await s.get<Room[]>("/api/rooms")).some(r => r.id === room.id && r.kind === "solo" && r.agenda === QUIET));
  });
});

describe("a channel on rooms", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  test("a post reaches every member's comm thread as if it tagged each one, and an agent's thread reply reaches every other member too", async () => {
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet check of the port", requestId: "ch-1" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.deliveries.map((d: { target: string }) => d.target), [agents.harness, agents.crawler, agents.frontend], "a post with no mention wakes every member");
    const comm = await until(async () => commOf(s, agents.crawler, ids.cutoverChannel), id => id !== undefined);
    await until(async () => submits.length, n => n === 3);
    assert.equal(host.threadsById.get(comm!)!.row.name, "Crawler VP · #pi-cutover");
    assert.match(submits.find(x => x.thread === comm)!.input.text!, /^\[#pi-cutover · post 8 from You \(owner\) · hops 0\]\n\nquiet check/);

    told(host, comm!, "c1", "Still on the old port, quiet. @frontend bro can you check the relay page?");
    await s.app.groups.feed(comm!);
    const reply = stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:c1`)!;
    assert.equal(reply.threadRoot, sent.body.item.id);
    assert.deepEqual(reply.mentions, [agents.frontend]);
    assert.deepEqual(reply.deliveries?.map(d => d.target), [agents.harness, agents.frontend], "a thread reply wakes every member but its author");
    await until(async () => submits.length, n => n === 5);
    for (const x of submits.slice(3)) assert.match(x.input.text!, /\(thread so far\)\n8 You: quiet check/);

    // pi-host keeps only from and via of an agent message, so frontend bro's answer finds the thread and its hops in the envelope header.
    const frontComm = commOf(s, agents.frontend, ids.cutoverChannel)!;
    told(host, frontComm, "f1", "Relay page is fine, quiet.");
    await s.app.groups.feed(frontComm);
    const answer = stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${frontComm}:f1`)!;
    assert.equal(answer.threadRoot, sent.body.item.id, "an answer to an agent's thread reply stays in the thread");
    assert.equal(answer.hops, 2);
    const thread = await s.get<{ root: Message; items: Message[] }>(`/api/c/${ids.cutoverChannel}/replies/${sent.body.item.id}`);
    const crawler = thread.root.deliveries.find(d => d.target === agents.crawler)!;
    assert.equal(crawler.state, "answered");
    assert.equal(crawler.answer, reply.id);
    host.beforeSubmit = undefined;
  });

  test("a thread reply sent with alsoInChannel shows in the channel with its root's first line, and a plain reply stays in its thread", async () => {
    const root = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet relay root\nsecond line", requestId: "also-root" });
    const plain = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, thread only", threadRoot: root.body.item.id, requestId: "also-plain" });
    const also = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, to the channel too", threadRoot: root.body.item.id, alsoInChannel: true, requestId: "also-both" });
    assert.deepEqual((also.body.item as Message).alsoInChannel, { rootText: "quiet relay root" });
    const channel = await posts(s, ids.cutoverChannel);
    assert.equal(channel.some(p => p.id === plain.body.item.id), false, "a plain reply stays out of the channel");
    const shown = channel.find(p => p.id === also.body.item.id);
    assert.equal(shown?.threadRoot, root.body.item.id);
    assert.deepEqual(shown?.alsoInChannel, { rootText: "quiet relay root" });
    const thread = await s.get<{ root: Message; items: Message[] }>(`/api/c/${ids.cutoverChannel}/replies/${root.body.item.id}`);
    assert.deepEqual(thread.items.map(i => [i.id, !!i.alsoInChannel]), [[plain.body.item.id, false], [also.body.item.id, true]]);
    assert.equal(thread.root.thread?.replies, 2, "the root counts both replies");
    const root2 = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, no thread", alsoInChannel: true, requestId: "also-top" });
    assert.equal("alsoInChannel" in root2.body.item, false, "a top-level post ignores the flag");
  });

  test("an agent's answers to two owner posts in one thread each record the post they answer, and each delivery reads as answered by its own", async () => {
    // #dev-search-general on 11-20: p15 came as a steer after the turn of p14 posted, and p15's delivery read as answered by the p14 answer.
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const root = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet catalog root", requestId: "ans-root" });
    const comm = commOf(s, agents.crawler, ids.cutoverChannel)!;
    const toComm = () => submits.filter(x => x.thread === comm).length;
    await until(async () => toComm(), n => n === 1);
    const first = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, what is the catalog now?", threadRoot: root.body.item.id, requestId: "ans-1" });
    await until(async () => toComm(), n => n === 2);
    told(host, comm, "a1", "5 pieces, quiet.");
    const second = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, is all code on it?", threadRoot: root.body.item.id, requestId: "ans-2" });
    await until(async () => toComm(), n => n === 3);
    told(host, comm, "a2", "not yet, quiet.");
    await s.app.groups.feed(comm);
    const [a1, a2] = ["a1", "a2"].map(id => stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:${id}`)!);
    assert.equal(a1!.answers, first.body.item.id);
    assert.equal(a2!.answers, second.body.item.id);
    const thread = await s.get<{ root: Message; items: Message[] }>(`/api/c/${ids.cutoverChannel}/replies/${root.body.item.id}`);
    const answerOf = (id: string) => thread.items.find(i => i.id === id)!.deliveries.find(d => d.target === agents.crawler)!.answer;
    assert.equal(answerOf(first.body.item.id), a1!.id);
    assert.equal(answerOf(second.body.item.id), a2!.id);
    assert.equal(thread.items.find(i => i.id === a2!.id)!.answers, second.body.item.id, "the page gets the post it answers");
    host.beforeSubmit = undefined;
  });

  test("an answer's live event carries the post it answers, whose delivery now reads as answered", async () => {
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const live = await s.live();
    live.watch(ids.cutoverChannel);
    const root = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet answer event root", requestId: "ev-root" });
    const comm = commOf(s, agents.crawler, ids.cutoverChannel)!;
    const toComm = () => submits.filter(x => x.thread === comm).length;
    await until(async () => toComm(), n => n === 1);
    const asked = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, which port?", threadRoot: root.body.item.id, requestId: "ev-asked" });
    await until(async () => toComm(), n => n === 2);
    told(host, comm, "ev-a", "the new one, quiet.");
    await s.app.groups.feed(comm);
    const answered = (event: LiveEvent) => event.type === "items" && event.conversation === ids.cutoverChannel &&
      event.items.some(item => item.id === asked.body.item.id && item.kind === "message" && item.deliveries.some(d => d.target === agents.crawler && d.state === "answered"));
    await live.waitFor(answered, 5_000);
    live.close();
    host.beforeSubmit = undefined;
  });

  test("a result posted with reply_to goes in the thread of the post it names, not of the newer root post whose turn it came in", async () => {
    // #sw-factory-build on 11-20: the result for p37 came in a turn after p27 and landed in p27's thread (c210).
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const comm = commOf(s, agents.crawler, ids.cutoverChannel)!;
    const toComm = () => submits.filter(x => x.thread === comm).length;
    const asked = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, run the reactions tests", requestId: "rt-asked" });
    await until(async () => toComm(), n => n === 1);
    const newer = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, what is solo?", requestId: "rt-newer" });
    await until(async () => toComm(), n => n === 2);
    told(host, comm, "rt-a", "solo is a group room, quiet.");
    host.append(host.threadsById.get(comm)!, 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "tests pass" }], timestamp: Date.now() }], data: { from: "w-1", via: "agent" } });
    told(host, comm, "rt-b", "tests pass, quiet.", asked.body.item.id);
    told(host, comm, "rt-c", "and again, quiet.", `${ids.cutoverChannel}/${asked.body.item.id}`);
    await s.app.groups.feed(comm);
    const [a, b, c] = ["rt-a", "rt-b", "rt-c"].map(id => stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:${id}`)!);
    assert.deepEqual([a!.threadRoot, a!.answers], [newer.body.item.id, newer.body.item.id], "with no reply_to a post goes where its turn's post is");
    assert.deepEqual([b!.threadRoot, b!.answers], [asked.body.item.id, asked.body.item.id]);
    assert.deepEqual([c!.threadRoot, c!.answers], [asked.body.item.id, asked.body.item.id]);
    assert.equal("replyTo" in b!, false, "the post stores no reply_to");
    host.beforeSubmit = undefined;
  });

  test("a result with no reply_to goes in the thread of the post its turn's closing calls name, also when its first try was refused", async () => {
    // #dev-app-search-prospect on 11-21: the work thread's report on p9 woke the comm thread after the owner's newer p11. Its round took 👀 off
    // p9 and marked p9 completed beside a tell_owner with no reply_to, tell_owner refused that post for a dead link, and the resend landed under p11.
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const comm = commOf(s, agents.crawler, ids.cutoverChannel)!;
    const t = host.threadsById.get(comm)!;
    const toComm = () => submits.filter(x => x.thread === comm).length;
    const asked = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, is our API serving?", requestId: "cl-asked" });
    await until(async () => toComm(), n => n === 1);
    const newer = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "quiet, what does breathing cost?", requestId: "cl-newer" });
    await until(async () => toComm(), n => n === 2);
    const stamp = stored(s, ids.cutoverChannel).find(p => p.id === asked.body.item.id)!.at.toString(36);
    const round = (content: ContentBlock[], results: [string, string, boolean][]) => {
      host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
      for (const [id, name, isError] of results) {
        host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: isError ? "Not sent, a wiki: link in it opens no page." : "told the owner" }], isError, timestamp: Date.now() }] });
      }
    };
    host.append(t, 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "the API serves 175 of 178 routes" }], timestamp: Date.now() }], data: { from: "w-1", via: "agent" } });
    round([
      { type: "toolCall", id: "cl-a", name: "tell_owner", arguments: { text: "yes, 175 of 178 routes work, quiet." } },
      { type: "toolCall", id: "cl-e", name: "set_emoji", arguments: { message_id: stamp, emoji: "eyes", on: false } },
      { type: "toolCall", id: "cl-m", name: "mark_message", arguments: { message_id: `${ids.cutoverChannel}/${asked.body.item.id}`, completed: true } },
    ], [["cl-e", "set_emoji", false], ["cl-m", "mark_message", false], ["cl-a", "tell_owner", true]]);
    round([{ type: "toolCall", id: "cl-b", name: "tell_owner", arguments: { text: "yes, 175 of 178 routes work, quiet." } }], [["cl-b", "tell_owner", false]]);
    // In the next report's turn the post and 👀 taken off its question go out in one round.
    host.append(t, 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "the cost page is up" }], timestamp: Date.now() }], data: { from: "w-1", via: "agent" } });
    round([
      { type: "toolCall", id: "cl-c", name: "tell_owner", arguments: { text: "about $2k a month, quiet." } },
      { type: "toolCall", id: "cl-d", name: "set_emoji", arguments: { message_id: newer.body.item.id, emoji: "eyes", on: false } },
    ], [["cl-c", "tell_owner", false]]);
    // A round that closes two posts names none, so its post goes where its turn's post is.
    host.append(t, 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "both done" }], timestamp: Date.now() }], data: { from: "w-1", via: "agent" } });
    round([
      { type: "toolCall", id: "cl-f", name: "tell_owner", arguments: { text: "both done, quiet." } },
      { type: "toolCall", id: "cl-g", name: "mark_message", arguments: { message_id: asked.body.item.id, completed: true } },
      { type: "toolCall", id: "cl-h", name: "mark_message", arguments: { message_id: newer.body.item.id, completed: true } },
    ], [["cl-f", "tell_owner", false]]);
    await s.app.groups.feed(comm);
    const [a, b, c, f] = ["cl-a", "cl-b", "cl-c", "cl-f"].map(id => stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:${id}`));
    assert.equal(a, undefined, "a refused post lands nothing");
    assert.deepEqual([b!.threadRoot, b!.answers], [asked.body.item.id, asked.body.item.id], "the resend answers the post the refused round closed");
    assert.deepEqual([c!.threadRoot, c!.answers], [newer.body.item.id, newer.body.item.id]);
    assert.deepEqual([f!.threadRoot, f!.answers], [newer.body.item.id, newer.body.item.id]);
    assert.equal("named" in b!, false, "the post stores no closing call ids");
    host.beforeSubmit = undefined;
  });

  test("an agent's mention of an agent outside the channel reaches that agent's comm thread for the channel, and it stays out of the members", async () => {
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    const comm = commOf(s, agents.crawler, ids.cutoverChannel)!;
    told(host, comm, "c2", "@Vent quiet, which box runs the relay now?");
    await s.app.groups.feed(comm);
    const post = stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:c2`)!;
    assert.deepEqual(post.mentions, [agents.vent]);
    assert.deepEqual(post.deliveries?.map(d => d.target), [agents.harness, agents.frontend, agents.vent], "every member, then the agent it mentions");
    const ventComm = await until(async () => commOf(s, agents.vent, ids.cutoverChannel), id => id !== undefined);
    await until(async () => submits.filter(x => x.thread === ventComm).length, n => n === 1);
    assert.equal(host.threadsById.get(ventComm!)!.row.name, "Vent · #pi-cutover");
    const room = (await s.get<Room[]>("/api/rooms")).find(r => r.id === ids.cutoverChannel)!;
    assert.ok(!room.members.some(m => m.principal.id === agents.vent), "a mention does not add the agent to the channel");
    const config = await s.get<AgentConfig>(`/api/agents/${agents.vent}/config`);
    assert.equal(config.swarm.commRooms.find(r => r.id === ids.cutoverChannel)?.membership, "mentioned", "its Threads tab says it is no member there");
    assert.equal(config.swarm.commRooms.find(r => r.id.startsWith("dm_"))?.membership, "member");
    host.beforeSubmit = undefined;
  });
});

describe("the room feed across a restart", () => {
  test("a comm thread's tell_owner lands as one room post however often it is read, and a delivery left sending goes out after a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-groups-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    try {
      const first = await start({ host, dataDir });
      let room: Room;
      let comm: string;
      try {
        room = (await first.send("POST", "/api/rooms", { kind: "solo", agenda: QUIET, members: [agents.vent] })).body;
        comm = await until(async () => commOf(first, agents.vent, room.id), id => id !== undefined) as string;
        await until(() => posts(first, room.id), p => p[0]?.deliveries[0]?.state === "delivered");
        told(host, comm, "t1", "One post, quiet.");
        await first.app.groups.feed(comm);
        first.app.agentStore.rooms.commFeed![comm]!.entry = 0;
        await first.app.groups.feed(comm);
        assert.equal(stored(first, room.id).filter(p => p.requestId === `m:${comm}:t1`).length, 1);
        // pi-host goes away: the owner's next post stays sending.
        host.beforeSubmit = () => {
          throw new Error("connect ECONNREFUSED pi-host");
        };
        await first.send("POST", `/api/c/${room.id}/send`, { text: "quiet, while pi-host is away", requestId: "restart-1" });
        await until(async () => stored(first, room.id).at(-1)!.deliveries![0]!.attempts, n => n >= 1);
      } finally {
        await first.close();
      }
      const saved = JSON.parse(readFileSync(join(dataDir, "rooms.json"), "utf8"));
      assert.ok(saved.commFeed[comm].entry > 0, "the comm thread's cursor is saved");
      host.beforeSubmit = undefined;

      const second = await start({ host, dataDir });
      try {
        await second.app.groups.feed(comm);
        assert.equal(stored(second, room.id).filter(p => p.requestId === `m:${comm}:t1`).length, 1, "the restart lands nothing twice");
        const pending = await until(async () => stored(second, room.id).find(p => p.requestId === "restart-1")!.deliveries![0]!, d => d.state === "delivered");
        assert.equal(pending.requestId, `d:${room.id}:p3:${agents.vent}`);
        assert.equal(pending.thread, comm);
        const inputs = host.threadsById.get(comm)!.entries.filter(e => e.kind === "pi.user" && JSON.stringify(e.model).includes("while pi-host is away"));
        assert.equal(inputs.length, 1);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("sequence (d) on the fixture", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  test("two agents answer the owner and each other until the 6-hop cap stops them, and closing the room stops the rest", async () => {
    const agenda = "Pick the relay protocol for the Mac";
    const room: Room = (await s.send("POST", "/api/rooms", { kind: "solo", agenda, members: [agents.vent, agents.frontend] })).body;
    const done = await until(async () => stored(s, room.id), list => list.filter(p => p.hops === MAX_HOPS).length === 2, 30_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    const all = stored(s, room.id);
    assert.equal(all.length, done.length, "nothing follows the stopped posts");
    assert.deepEqual(all.map(p => p.hops), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    for (const post of all.filter(p => p.author !== "owner")) {
      assert.equal(post.deliveries?.length, 1, `${post.id} wakes the other member only`);
      assert.notEqual(post.deliveries![0]!.target, post.author);
      assert.equal(post.deliveries![0]!.state, post.hops === MAX_HOPS ? "stopped" : "delivered");
    }
    assert.deepEqual(new Set(all.filter(p => p.hops === 1).map(p => p.author)), new Set([agents.vent, agents.frontend]), "both answer the owner");
    const page = await posts(s, room.id);
    assert.ok(page.filter(p => p.author.id !== "owner").every(p => p.text.startsWith("Got it.") && p.work?.conversation));

    await s.send("PATCH", `/api/rooms/${room.id}`, { closed: true });
    const refused = await s.send("POST", `/api/c/${room.id}/send`, { text: "one more?", requestId: "seq-d-closed" });
    assert.equal(refused.status, 400);
    assert.equal(stored(s, room.id).length, all.length);
  });

  test("an agent's echo of a mention names no one, and a mentioned outsider hears the thread it is in until the hop cap", async () => {
    const room: Room = (await s.send("POST", "/api/rooms", { kind: "channel", name: "echo-loop", members: [agents.vent, agents.frontend] })).body;
    await s.send("POST", `/api/c/${room.id}/send`, { text: "@Crawler VP is the relay fine?", mentions: [agents.crawler], requestId: "echo-loop-1" });
    // The room is done once no delivery is still sending and no post came in for 1.5 s.
    for (let calm = 0, last = -1, end = Date.now() + 30_000; calm < 3 && Date.now() < end;) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const list = stored(s, room.id);
      calm = list.length === last && list.every(p => (p.deliveries ?? []).every(d => d.state !== "sending")) ? calm + 1 : 0;
      last = list.length;
    }
    const all = stored(s, room.id);
    const agentPosts = all.filter(p => p.author !== "owner");
    assert.deepEqual(agentPosts.flatMap(p => p.mentions ?? []), [], "no agent post mentions anyone");
    // The root named Crawler VP, so it is involved in the root's thread and hears its replies, as Slack notifies a mentioned person.
    const root = all.find(p => p.author === "owner")!;
    assert.ok(agentPosts.every(p => p.threadRoot === root.id), "every answer stays in the owner's thread");
    assert.ok(all.filter(p => p.deliveries?.some(d => d.target === agents.crawler)).length > 1);
    assert.ok(agentPosts.some(p => p.hops === MAX_HOPS && p.deliveries?.every(d => d.state === "stopped")), "the hop cap ends the replies");
  });
});

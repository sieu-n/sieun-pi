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
import type { ConversationHeader, Item, Room, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
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

/** A tell_owner call and its result in conversation 1 of `thread`. */
function told(host: FixtureHost, thread: string, id: string, text: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer" } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

/** An agent message from `from`, as a delivery of `post` in `room` at `hops`, typed straight into a comm thread. */
function delivered(host: FixtureHost, thread: string, from: string, room: string, post: string, hops: number): void {
  host.append(host.threadsById.get(thread)!, 1, {
    kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: `[test · post 1 from x · hops ${hops}]\n\nquiet` }], timestamp: Date.now() }],
    data: { from, via: room, post, hops },
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
    assert.deepEqual(sent.input.entry, { kind: "agent.message", data: { from: agents.vent, via: room.id, post: p2.id, hops: 1 } });
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

  test("a mention reaches only the mentioned member's comm thread; its answer is a thread reply that wakes nobody it does not name", async () => {
    const submits: SubmitInput[] = [];
    host.beforeSubmit = (_thread, input) => void submits.push(input);
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@Crawler VP quiet check of the port", mentions: [agents.crawler], requestId: "ch-1" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.deliveries.map((d: { target: string }) => d.target), [agents.crawler], "members wake on a mention only");
    const comm = await until(async () => commOf(s, agents.crawler, ids.cutoverChannel), id => id !== undefined);
    await until(async () => submits.length, n => n === 1);
    assert.equal(host.threadsById.get(comm!)!.row.name, "Crawler VP · #pi-cutover");
    assert.match(submits[0]!.text!, /^\[#pi-cutover · post 8 from You \(owner\) · hops 0\]\n\n@Crawler VP quiet check/);

    told(host, comm!, "c1", "Still on the old port. @frontend bro can you check the relay page?");
    await s.app.groups.feed(comm!);
    const reply = stored(s, ids.cutoverChannel).find(p => p.requestId === `m:${comm}:c1`)!;
    assert.equal(reply.threadRoot, sent.body.item.id);
    assert.deepEqual(reply.mentions, [agents.frontend]);
    assert.deepEqual(reply.deliveries?.map(d => d.target), [agents.frontend]);
    await until(async () => submits.length, n => n === 2);
    assert.match(submits[1]!.text!, /\(thread so far\)\n8 You: @Crawler VP quiet check/);
    const thread = await s.get<{ root: Message; items: Message[] }>(`/api/c/${ids.cutoverChannel}/replies/${sent.body.item.id}`);
    assert.equal(thread.root.deliveries[0]!.state, "answered");
    assert.equal(thread.root.deliveries[0]!.answer, reply.id);
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
});

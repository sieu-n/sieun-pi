/**
 * Threads in a Solo room (server/group-rooms.ts): the owner replies in the thread of any root post, each member reads the reply with a line
 * that names its thread and the thread so far, an answer to that reply lands in the thread, an answer to a root post stays at the root, and
 * the room's timeline shows only root posts with a reply count, as a channel's and a DM's do.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/solo-threads.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, Room, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, SubmitInput } from "../../server/host/types.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const ROOM = ids.soloRoom;
const roots = async (s: Running): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${ROOM}/items?limit=200`)).items.filter(i => i.kind === "message") as Message[];
const thread = (s: Running, root: string) => s.get<{ root: Message; items: Message[] }>(`/api/c/${ROOM}/replies/${root}`);
const stored = (s: Running, room: string) => s.app.agentStore.postsOf(room);

/** A tell_owner call and its result in conversation 1 of `thread`, with `reply_to` when given. */
function told(host: FixtureHost, thread: string, id: string, text: string, replyTo?: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer", ...(replyTo ? { reply_to: replyTo } : {}) } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

describe("threads in a Solo room", () => {
  let s: Running;
  let host: FixtureHost;
  const submits: { thread: string; input: SubmitInput }[] = [];
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
  });
  after(async () => {
    await s.close();
  });

  test("a reply on an agent's post goes in its thread and reaches each member with the thread, and their answers land in the thread", async () => {
    const root = (await roots(s)).find(m => m.author.id === agents.vent)!;
    const text = `and if the Mac sleeps for a day? ${Date.now()}`;
    const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "sot-1", threadRoot: root.id });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.item.threadRoot, root.id);
    assert.deepEqual(sent.body.deliveries.map((d: { target: string }) => d.target).sort(), [agents.frontend, agents.vent].sort(), "a thread reply wakes every member");

    const input = await until(async () => submits.find(x => x.input.text?.includes(text)), found => found !== undefined);
    assert.ok(input!.input.text!.includes(`· hops 0]\n(a reply in the thread of post ${root.seq}; your answer goes in that thread)\n\n${text}`), input!.input.text);
    assert.match(input!.input.text!, new RegExp(`\\(thread so far\\)\\n${root.seq} Vent: One WebSocket per box`));

    const replies = await until(() => thread(s, root.id), t => t.items.filter(m => m.author.id !== "owner").length >= 2);
    assert.equal(replies.items[0]!.id, sent.body.item.id);
    assert.ok(replies.items.every(m => m.threadRoot === root.id), "every answer stays in the thread");
    const answers = replies.items.filter(m => m.answers === sent.body.item.id).map(m => m.author.id).sort();
    assert.deepEqual(answers, [agents.frontend, agents.vent].sort(), "each member's answer names his reply");

    const after = await roots(s);
    assert.equal(after.some(m => m.threadRoot), false, "the room's timeline shows root posts only");
    const shown = after.find(m => m.id === root.id)!;
    assert.equal(shown.thread?.replies, (await thread(s, root.id)).items.length);
    const around = await s.get<TimelinePage>(`/api/c/${ROOM}/items?around=${replies.items[1]!.id}`);
    assert.equal(around.focus, root.id, "a link to a reply opens its root");
  });

  test("an answer to a root post stays at the root, and one whose reply_to names the root of the turn's thread goes in that thread", async () => {
    // A room of its own with Vent alone. In the seeded room the first test's members go on answering each other in post 2's thread for up
    // to 6 hops, and a tell_owner appended during one of those turns answers that turn's post instead of the owner's.
    const room: Room = (await s.send("POST", "/api/rooms", { kind: "solo", agenda: "quiet: pick the relay port", members: [agents.vent] })).body;
    const asked = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, which port?", requestId: "sot-root" });
    const comm = await until(async () => s.app.agents.record(agents.vent)!.comm?.[room.id], id => id !== undefined) as string;
    await until(async () => host.threadsById.get(comm)!.entries.some(e => e.kind === "pi.user" && JSON.stringify(e.model?.[0]?.content).includes("quiet, which port?")), Boolean);
    told(host, comm, "sot-a", "Port 7443, quiet.");
    await s.app.groups.feed(comm);
    const a = stored(s, room.id).find(p => p.requestId === `m:${comm}:sot-a`)!;
    assert.deepEqual([a.threadRoot, a.answers], [undefined, asked.body.item.id]);

    const reply = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, and the fallback?", requestId: "sot-thread", threadRoot: a.id });
    await until(async () => host.threadsById.get(comm)!.entries.some(e => e.kind === "pi.user" && JSON.stringify(e.model?.[0]?.content).includes("quiet, and the fallback?")), Boolean);
    told(host, comm, "sot-b", "No fallback, quiet.", `p${a.seq}`);
    await s.app.groups.feed(comm);
    const b = stored(s, room.id).find(p => p.requestId === `m:${comm}:sot-b`)!;
    assert.equal(b.threadRoot, a.id, "reply_to the thread's root keeps the answer in the thread");
    assert.ok(reply.body.item.threadRoot === a.id);
  });

  test("a reply that names other members tells each member it does not name, and only that member", async () => {
    // #dev-crawler p45 (mww0ks1y): the owner asked "@Search product, misc. and @fable auditor agree right? agree on the details, then go
    // implement", and devops guy, in the thread but not named, answered for them and started its own build.
    const room: Room = (await s.send("POST", "/api/rooms", { kind: "solo", agenda: "named: who picks the port", members: [agents.vent, agents.frontend] })).body;
    const root = await s.send("POST", `/api/c/${room.id}/send`, { text: "named, which port?", requestId: "sot-named-root" });
    const text = `@Frontend agree right? then go ${Date.now()}`;
    await s.send("POST", `/api/c/${room.id}/send`, { text, requestId: "sot-named", threadRoot: root.body.item.id, mentions: [agents.frontend] });
    const got = await until(async () => submits.filter(x => x.input.text?.includes(text)), found => found.length === 2);
    const of = (agent: typeof agents.vent) => got.find(x => x.thread === s.app.agents.record(agent)!.comm?.[room.id])!.input.text!;
    const name = s.app.agents.record(agents.frontend)!.name;
    assert.ok(of(agents.vent).includes(`your answer goes in that thread)\n(this post names ${name}, not you)\n\n${text}`), of(agents.vent));
    assert.doesNotMatch(of(agents.frontend), /not you\)/);
  });

  test("a thread starts only on a root post of the room", async () => {
    const root = (await roots(s)).find(m => m.thread)!;
    const reply = (await thread(s, root.id)).items[0]!;
    for (const threadRoot of [reply.id, "p99999"]) {
      const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text: "quiet", requestId: `sot-bad-${threadRoot}`, threadRoot });
      assert.equal(sent.status, 400, threadRoot);
    }
  });
});

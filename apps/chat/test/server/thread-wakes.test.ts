/**
 * Who a post wakes in a channel or Solo room (server/group-rooms.ts point 1), as Slack notifies: a root post wakes every member, and a thread
 * reply wakes only the agents involved in that thread, which are the root's author, every agent that replied in it or that the root or a
 * reply @mentions, and every agent a root with no mention woke. The owner's words, #1124-cost-management p6: "reply는 thread에
 * involve(either direct mentioned, or replied once)된 agent만".
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/thread-wakes.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ForMeList } from "../../web/src/lib/api/types.ts";
import type { ContentBlock } from "../../server/host/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let host: FixtureHost;
before(async () => {
  s = await start({ wordMs: 0 });
  host = s.host as FixtureHost;
});
after(async () => {
  await s.close();
});

const targets = (body: { deliveries: { target: string }[] }) => body.deliveries.map(d => d.target);
const send = async (room: string, body: Record<string, unknown>) => {
  const res = await s.send("POST", `/api/c/${room}/send`, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { item: { id: string }; deliveries: { target: string }[] };
};

/** A tell_owner call and its result in conversation 1 of `thread`, as the agent's answer in the room. */
function told(thread: string, id: string, text: string, replyTo?: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer", ...(replyTo ? { reply_to: replyTo } : {}) } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

test("a root post wakes every member; a reply in its thread wakes only the agents the root named or that replied, and a mention adds one", async () => {
  const room = ids.cutoverChannel;
  const root = await send(room, { text: "@Crawler VP quiet, is the port free?", mentions: [agents.crawler], requestId: "tw-1" });
  assert.deepEqual(targets(root), [agents.harness, agents.crawler, agents.frontend], "a root post wakes every member");

  const reply = await send(room, { text: "quiet, and the old one?", threadRoot: root.item.id, requestId: "tw-2" });
  assert.deepEqual(targets(reply), [agents.crawler], "a reply wakes only the agent the root named, never a member the root did not name");

  const named = await send(room, { text: "@frontend bro quiet, can you check the page?", mentions: [agents.frontend], threadRoot: root.item.id, requestId: "tw-3" });
  assert.deepEqual(targets(named), [agents.crawler, agents.frontend], "a mention in a reply wakes that agent too");

  const next = await send(room, { text: "quiet, any news?", threadRoot: root.item.id, requestId: "tw-4" });
  assert.deepEqual(targets(next), [agents.crawler, agents.frontend], "an agent mentioned once in the thread stays involved");

  // The uninvolved member's For list holds the root it got and none of the thread's replies.
  const list = (await s.get<ForMeList>(`/api/agents/${agents.harness}/for-me?status=all`)).items.filter(i => i.room === room).map(i => i.post);
  assert.ok(list.includes(root.item.id));
  for (const post of [reply, named, next]) assert.ok(!list.includes(post.item.id), `${post.item.id} is not on the uninvolved member's For list`);
});

test("a reply in the thread of a root with no mention wakes every member that root woke, since such a root tags each member", async () => {
  const room = ids.cutoverChannel;
  const root = await send(room, { text: "quiet, a check for everyone", requestId: "tw-5" });
  assert.deepEqual(targets(root), [agents.harness, agents.crawler, agents.frontend]);
  const reply = await send(room, { text: "quiet, one more thing", threadRoot: root.item.id, requestId: "tw-6" });
  assert.deepEqual(targets(reply), [agents.harness, agents.crawler, agents.frontend]);
});

test("an agent that replied in a thread is involved, and an agent root post's author is involved in its thread", async () => {
  // In a channel: crawler answers in the thread of a root that named only frontend bro, so the next reply wakes both.
  const room = ids.cutoverChannel;
  const root = await send(room, { text: "@frontend bro quiet, is the relay page up?", mentions: [agents.frontend], requestId: "tw-7" });
  const comm = await until(async () => s.app.agents.record(agents.crawler)!.comm?.[room], id => id !== undefined);
  told(comm!, "tw-c1", "The relay port is free, quiet.", root.item.id);
  await s.app.groups.feed(comm!);
  const answer = s.app.agentStore.postsOf(room).find(p => p.requestId === `m:${comm}:tw-c1`)!;
  assert.equal(answer.threadRoot, root.item.id);
  const reply = await send(room, { text: "quiet, thanks", threadRoot: root.item.id, requestId: "tw-8" });
  assert.deepEqual(targets(reply), [agents.crawler, agents.frontend], "the agent that replied once and the one the root named");

  // In a Solo room an answer to a root post stays at the root; one that names only the owner leaves the other member out of its thread.
  const solo = ids.soloRoom;
  const asked = await send(solo, { text: "@Vent quiet, which box runs the relay?", mentions: [agents.vent], requestId: "tw-9" });
  const ventComm = await until(async () => s.app.agents.record(agents.vent)!.comm?.[solo], id => id !== undefined);
  told(ventComm!, "tw-v1", "@owner us-metal02 runs it, quiet.", asked.item.id);
  await s.app.groups.feed(ventComm!);
  const ventRoot = s.app.agentStore.postsOf(solo).find(p => p.requestId === `m:${ventComm}:tw-v1`)!;
  assert.equal(ventRoot.threadRoot, undefined, "the answer to a root post is a root post");
  assert.deepEqual(ventRoot.mentions, ["owner"]);
  const followUp = await send(solo, { text: "quiet, since when?", threadRoot: ventRoot.id, requestId: "tw-10" });
  assert.deepEqual(targets(followUp), [agents.vent], "the root's author is involved and the member it did not name is not");
});

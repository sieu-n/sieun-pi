/**
 * An archived agent in a room (server/group-rooms.ts point 7): it stays a member, marked `archived`, as Slack keeps a deactivated member,
 * but no owner post, @mention, agent post or mention from outside the room wakes it, and its DM refuses the owner's post. Its unarchive
 * brings the deliveries back with the same membership.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/archived-agent.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ContentBlock } from "../../server/host/types.ts";
import type { Room } from "../../web/src/lib/api/types.ts";
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

const room = ids.cutoverChannel;
const targets = (body: { deliveries: { target: string }[] }) => body.deliveries.map(d => d.target);
const dmOf = (agent: string) => s.app.agents.record(agent)!.room;
const setArchived = async (agent: string, archived: boolean) => {
  const res = await s.send("PATCH", `/api/c/${dmOf(agent)}`, { archived });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await until(async () => s.app.agents.record(agent)!.archived, a => a === archived);
};
const memberOf = async (agent: string) => (await s.get<Room[]>("/api/rooms")).find(r => r.id === room)!.members.find(m => m.principal.id === agent);

/** A tell_owner call and its result in conversation 1 of `thread`. */
function told(thread: string, id: string, text: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer" } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

test("an archived member stays listed as archived and no post, @mention or agent mention wakes it; unarchived, it hears posts again", async () => {
  const first = await s.send("POST", `/api/c/${room}/send`, { text: "quiet, before the archive", requestId: "arch-0" });
  assert.deepEqual(targets(first.body), [agents.harness, agents.crawler, agents.frontend]);

  await setArchived(agents.frontend, true);
  const member = await memberOf(agents.frontend);
  assert.ok(member, "the archive keeps the membership");
  assert.equal(member.archived, true);

  const post = await s.send("POST", `/api/c/${room}/send`, { text: "quiet, after the archive", requestId: "arch-1" });
  assert.equal(post.status, 200);
  assert.deepEqual(targets(post.body), [agents.harness, agents.crawler], "a plain post skips the archived member");
  const mention = await s.send("POST", `/api/c/${room}/send`, { text: "@frontend bro quiet, are you there?", mentions: [agents.frontend], requestId: "arch-2" });
  assert.deepEqual(targets(mention.body), [agents.harness, agents.crawler], "an @mention does not wake the archived member");
  const reply = await s.send("POST", `/api/c/${room}/send`, { text: "quiet, in the thread", threadRoot: first.body.item.id, requestId: "arch-3" });
  assert.deepEqual(targets(reply.body), [agents.harness, agents.crawler], "a reply in a thread it was woken in does not wake it");

  // An agent's mention of an archived agent, a member or one outside the room, wakes neither.
  await setArchived(agents.vent, true);
  const comm = await until(async () => s.app.agents.record(agents.crawler)!.comm?.[room], id => id !== undefined);
  told(comm!, "arch-c1", "@frontend bro @Vent quiet, which box runs the relay?");
  await s.app.groups.feed(comm!);
  const agentPost = s.app.agentStore.postsOf(room).find(p => p.requestId === `m:${comm}:arch-c1`)!;
  assert.ok(agentPost.mentions?.includes(agents.frontend));
  assert.deepEqual(agentPost.deliveries?.map(d => d.target), [agents.harness]);

  const dm = await s.send("POST", `/api/c/${dmOf(agents.frontend)}/send`, { text: "quiet, a DM", requestId: "arch-dm" });
  assert.equal(dm.status, 400, "the archived agent's DM refuses a post");
  assert.match(dm.body.error, /archived/);

  await setArchived(agents.frontend, false);
  await setArchived(agents.vent, false);
  assert.equal((await memberOf(agents.frontend))!.archived, undefined);
  const back = await s.send("POST", `/api/c/${room}/send`, { text: "quiet, after the unarchive", requestId: "arch-4" });
  assert.deepEqual(targets(back.body), [agents.harness, agents.crawler, agents.frontend], "the unarchive brings deliveries back with the same membership");
  const ventBack = await s.send("POST", `/api/c/${room}/send`, { text: "@Vent quiet", mentions: [agents.vent], requestId: "arch-5" });
  assert.ok(targets(ventBack.body).includes(agents.vent));
});

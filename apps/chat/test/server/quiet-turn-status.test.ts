/**
 * A room's status follows its threads' runs as they start and end, also a run that a thread list read never saw: a comm turn that posts
 * nothing ends between two reads, and before this the page kept the room working, with Stop on the DM, until some later change
 * (test/channel/send-message.spec.ts failed on it). A turn that waits for a working slot is still in flight: its room sleeps, and Stop ends
 * the wait with no model call and gives its queue place back.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/quiet-turn-status.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type LiveClient, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
type Status = Extract<LiveEvent, { type: "status" }>;
const DM = "dm_vent";

/** Sends `text` to `room` and answers the room's status events from that send on, once one says idle after one said working. */
async function quietTurn(s: Running, live: LiveClient, room: string, text: string): Promise<Status[]> {
  const from = live.events.length;
  const statuses = () => live.events.slice(from).filter((e): e is Status => e.type === "status" && e.conversation === room);
  const sent = await s.send("POST", `/api/c/${room}/send`, { text, requestId: `quiet-${room}-${Date.now()}` });
  assert.equal(sent.status, 200);
  await until(async () => statuses(), list => list.some(e => e.status === "working"), 5_000);
  // Within 1 s, under the 2 s between thread list reads, so only the run's own end can have sent it.
  return until(async () => statuses(), list => list.findIndex(e => e.status === "working") < list.findLastIndex(e => e.status === "idle"), 1_000)
    .catch(() => assert.fail(`${room} stayed working after the quiet turn: ${JSON.stringify(statuses())}`));
}

describe("a quiet comm turn's end reaches the page", () => {
  let s: Running;
  let live: LiveClient;
  before(async () => {
    s = await start({ wordMs: 0 });
    live = await s.live();
  });
  after(async () => {
    live.close();
    await s.close();
  });

  test("a DM goes back to idle when its comm turn ends without a post", async () => {
    live.watch(DM);
    await live.waitFor(e => e.type === "status" && e.conversation === DM);
    // An answered post first, so the comm thread's watch is up before the quiet one.
    await s.send("POST", `/api/c/${DM}/send`, { text: "how is the relay", requestId: "quiet-first" });
    await until(async () => (await s.get<TimelinePage>(`/api/c/${DM}/items?limit=50`)).items as Message[], items => items.some(i => i.author.id !== "owner" && i.text.includes("how is the relay")));
    const postsBefore = ((await s.get<TimelinePage>(`/api/c/${DM}/items?limit=50`)).items as Message[]).filter(i => i.author.id !== "owner").length;
    await quietTurn(s, live, DM, "quiet check");
    const header = await s.get(`/api/c/${DM}`);
    assert.equal(header.summary.status, "idle");
    const posts = ((await s.get<TimelinePage>(`/api/c/${DM}/items?limit=50`)).items as Message[]).filter(i => i.author.id !== "owner");
    assert.equal(posts.length, postsBefore, "the quiet turn posts nothing");
  });

  test("a channel goes back to idle when its members' comm turns end without a post", async () => {
    live.watch(ids.cutoverChannel);
    await quietTurn(s, live, ids.cutoverChannel, "quiet check of the port");
  });
});

describe("a comm turn that waits for a working slot", () => {
  let s: Running;
  let live: LiveClient;
  before(async () => {
    s = await start({ wordMs: 1 });
    live = await s.live();
  });
  after(async () => {
    live.close();
    await s.close();
  });

  test("its DM sleeps while it waits, and Stop ends the wait with no answer and no queue place", async () => {
    const host = s.host as FixtureHost;
    const comm = s.app.agents.record(s.app.agents.list().find(r => r.room === DM)!.id)!.comm![DM]!;
    live.watch(DM);
    await live.waitFor(e => e.type === "status" && e.conversation === DM);
    const from = live.events.length;
    const after = <E extends LiveEvent>(match: (e: LiveEvent) => e is E) => live.events.slice(from).filter(match);
    const sent = await s.send("POST", `/api/c/${DM}/send`, { text: "queue long check", requestId: "queue-long-1" });
    assert.equal(sent.status, 200);
    await until(async () => after((e): e is Status => e.type === "status" && e.conversation === DM), list => list.some(e => e.status === "sleeping"), 5_000);
    await until(async () => after((e): e is Extract<LiveEvent, { type: "queue" }> => e.type === "queue" && e.conversation === DM), list => list.some(e => e.place !== null), 5_000);
    assert.equal((await s.get(`/api/c/${DM}`)).summary.status, "sleeping", "the header reads the wait too");

    const answered = () => host.threadsById.get(comm)!.entries.filter(e => e.kind === "pi.assistant").length;
    const answersBefore = answered();
    const stopAt = live.events.length;
    assert.equal((await s.send("POST", `/api/c/${DM}/abort`)).status, 200);
    const since = () => live.events.slice(stopAt);
    await until(async () => since(), list => list.some(e => e.type === "status" && e.conversation === DM && e.status === "idle"), 1_000)
      .catch(() => assert.fail(`${DM} kept waiting after Stop: ${JSON.stringify(since())}`));
    await until(async () => since(), list => list.some(e => e.type === "queue" && e.conversation === DM && e.place === null), 4_000)
      .catch(() => assert.fail(`the wait line stayed after Stop: ${JSON.stringify(since())}`));
    assert.equal((await host.ticket(comm))?.place.state, "none", "the queue place is given back");
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.ok(answered() <= answersBefore + 1, "at most the stopped turn's own entry");
    assert.equal(host.threadsById.get(comm)!.entries.filter(e => e.kind === "pi.assistant" && JSON.stringify(e.model).includes("send_message")).length, 0, "no model call answers it");
    const posts = ((await s.get<TimelinePage>(`/api/c/${DM}/items?limit=50`)).items as Message[]).filter(i => i.author.id !== "owner" && i.at > Date.now() - 10_000);
    assert.deepEqual(posts, [], "no post comes after the Stop");
    assert.equal((await s.get(`/api/c/${DM}`)).summary.status, "idle");
  });
});

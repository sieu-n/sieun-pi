/**
 * A room's status follows its threads' runs as they start and end, also a run that a thread list read never saw: a comm turn that posts
 * nothing ends between two reads, and before this the page kept the room working, with Stop on the DM, until some later change
 * (test/channel/send-message.spec.ts failed on it).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/quiet-turn-status.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
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

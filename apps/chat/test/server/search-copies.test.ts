/**
 * Search shows each message once (c191 totals stay exact): a channel post is found in its channel and not again as the copy its delivery
 * sent into the member's comm thread, and a thread imported beside its archived source shows its entries once, from the unarchived thread.
 * On 2026-10-28 the owner's "all good" search showed his #vent-dev post with its routing header, and every Oct 18 vent hit twice.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  // The fixture's agents answer each other while a first fill runs, so the index is filled before the test posts.
  await s.app.searchEngine.settled();
});
after(() => s.close());

test("a mention is found once, as the post in its channel, with no routing header", async () => {
  const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: "@frontend bro is the quokka page fine?", mentions: [ids.frontend], requestId: "copy-1" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const host = s.host as FixtureHost;
  const comm = await until(async () => s.app.agents.record(ids.frontend)?.comm?.[ids.cutoverChannel], id => id !== undefined);
  await until(() => host.entries(comm!, { limit: 50 }), page => page.entries.some(e => e.kind === "pi.user" && JSON.stringify(e.model).includes("quokka")));
  const result = await s.get<SearchResult>("/api/search?q=quokka%20page");
  const asked = result.hits.filter(h => h.author.id === "owner");
  assert.deepEqual(asked.map(h => [h.conversation.id, h.kind]), [[ids.cutoverChannel, "post"]]);
  assert.equal(result.total, result.hits.length);
  assert.ok(result.hits.every(h => !h.snippet.includes("posted back")));
});

test("a thread imported beside its archived source shows each entry once, from the unarchived thread", async () => {
  const host = s.host as FixtureHost;
  // Both counts come from Meilisearch, whose typo tolerance finds more than the in-memory read of documents it does not hold yet.
  await s.app.searchEngine.settled();
  const before = await s.get<SearchResult>("/api/search?q=relay&limit=100");
  const source = host.addThread({ name: "Vent", createdAt: Date.now() - 86_400_000, archived: true });
  source.entries.push(...host.threadsById.get(ids.vent)!.entries.map(entry => ({ ...entry })));
  await s.app.searchEngine.settled();
  const after = await s.get<SearchResult>("/api/search?q=relay&limit=100");
  // The fixture's agents may post meanwhile, so the thread hits are compared; every hit fits on the page, so the total holds the posts too.
  const entries = (result: SearchResult) => result.hits.filter(h => h.kind !== "post");
  assert.ok(after.total <= 100);
  assert.equal(after.total - (after.hits.length - entries(after).length), before.total - (before.hits.length - entries(before).length));
  assert.deepEqual(entries(after).map(h => h.id).sort(), entries(before).map(h => h.id).sort());
  assert.ok(!after.hits.some(h => h.conversation.id.startsWith(source.row.id)));
});

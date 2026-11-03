/**
 * The search index's filters read the same in Meilisearch's string form and in memory, where search reads the documents Meilisearch does
 * not hold yet; copies of one entry in several threads share one document id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_COPY_LIKE } from "../../server/group-rooms.ts";
import { and, entryDocId, eq, filterText, holds, isIn, likeRegex, not, or, type EntryDoc } from "../../server/search-engine.ts";

const doc: EntryDoc = {
  id: "e1_x", source: "entry", text: "zebra", at: 2_000, tier: 0, kind: "pi.user", author: "owner", entry: 1,
  threads: ["old", "live"], convs: ["old:1", "live:1"], keys: ["old:1", "live:1"], channelCopy: false,
};

test("a filter reads as Meilisearch's string and holds the same way in memory, arrays matching any element", () => {
  const where = and(eq("source", "entry"), or(eq("convs", "live:1"), eq("author", "nobody")), not(isIn("threads", ["comm"])), { op: "gte", field: "at", value: 1_000 });
  assert.equal(filterText(where), '(source = "entry") AND ((convs = "live:1") OR (author = "nobody")) AND (NOT (threads IN ["comm"])) AND (at >= 1000)');
  assert.equal(holds(where, doc), true);
  assert.equal(holds(and(where, not(isIn("keys", ["live:1"]))), doc), false);
  assert.equal(holds({ op: "lt", field: "at", value: 2_000 }, doc), false);
});

test("the channel-copy pattern matches a channel post's copy as SQLite's LIKE does, and copies share one id", () => {
  const like = likeRegex(CHANNEL_COPY_LIKE);
  assert.ok(like.test("[#vent-dev · post 2 from You (owner) · your final answer is posted back into this thread]\n\n@vent zebra up?"));
  assert.ok(!like.test("@vent zebra up?"));
  const row = { entryId: 7, kind: "pi.user", author: "owner", at: 5 };
  assert.equal(entryDocId(row), entryDocId({ ...row }));
  assert.notEqual(entryDocId(row), entryDocId({ ...row, at: 6 }));
  assert.match(entryDocId(row), /^[\w-]+$/);
});

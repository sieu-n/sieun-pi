/**
 * apps/chat holds an agent's edit that runs long once, as tell_owner does (`longEdit`, c98): on 11-21 a blind run's work thread grew a
 * checklist over its edits from 54 to 78 to 86 words, and on 11-24 a job's own call of the edit route made #dev-crawler p5 251 words.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MODEL_POST } from "../../src/durable/agent-profile.ts";
import { LONG_EDIT_MARK, longEdit } from "../../src/durable/long-edit.ts";
import { TABLE_EDIT_MARK, tableEdit } from "../../src/durable/room-tools.ts";

const checklist = (items: number) => ["yes, both boxes match main and every link resolves", "- this box",
  ...Array.from({ length: items }, (_, i) => `  - [x] check ${i + 1} passed on the box with nothing left`)].join("\n");

test("an edit over a room's 120 words is held once with a note, and the very same text sent again goes out", () => {
  const held = new Set<string>();
  const long = checklist(16);
  const note = longEdit(long, held);
  assert.ok(note?.startsWith(LONG_EDIT_MARK), note);
  assert.match(note!, /words in all\. Keep the post within 120 words: the answer on its own line/);
  assert.equal(longEdit(long, held), undefined, "the resend edits the post");
});

/** #dev-crawler p5 as a job of Search product, misc. edited it on 11-24 through the edit route, past edit_message's check. */
const P5_EDIT = "Most of it is helper objects, not data. Prod has 339 objects, and only 145 of them hold data. The other 180 are views, feed tables and lookups, and 14 are bookkeeping tables. The usual setup is one database per domain, with the same names on every tier, made by code, and observability in one shared store tagged by env. We run it that way now.\nhttps://us-metal02-dev.tail0c093d.ts.net:5184/wiki/domains/devops/clickhouse-layout.html\n\n- crawler has 79 data tables, 96 helpers and 13 bookkeeping tables on prod and 79/68/12 on staging, and the crawler-v3 bootstrap makes every data table.\n- q (2 data, 35 views) and q_pg (14 Postgres passthroughs) are the query MCP's catalog, and local got them today, so all three tiers now have them.\n- ledger (4/3), links (1) and outreach (1) are the same on every tier and come from the crawler-v3 bootstrap, and links was hand-made until today.\n- otel (48/28), ops (2/1) and langfuse (8/3/1) live once on prod, holding every tier's telemetry by env tag, and 10 of the otel tables come from the collector and HyperDX rather than the repo.\n- Dropped: ledger.hourly_actor, which had no reader. It is gone on local now, and staging and prod drop it at their next deploy.\n- Also dropped: staging's q.instagram_posts (13.8M unread rows), at the next staging deploy.\n- Crawler guy is dropping the 28 legacy prod views, ad_snapshot_events and the empty Instagram daily table.\n\nOne call for you: should we retire HyperDX? Its 3 tables got 0 queries in 14 days, and Grafana reads the same data.";

test("the 11-24 p5 edit counts 251 words and is held once", () => {
  const held = new Set<string>();
  assert.match(longEdit(P5_EDIT, held) ?? "", /^Not edited, it runs long, with .*251 words in all\./);
  assert.equal(longEdit(P5_EDIT, held), undefined, "the resend edits the post");
});

test("list and task markers are no words, so a checklist of 74 words that is 96 tokens with them passes", () => {
  const held = new Set<string>();
  assert.equal(longEdit(checklist(7), held), undefined);
  assert.equal(held.size, 0);
});

test("the post the owner called a model, 92 words, edits on the first try (msg mwqtp2l1)", () => {
  const held = new Set<string>();
  assert.equal(longEdit(MODEL_POST, held), undefined);
});

test("an edit with a table is held once, and the very same text sent again goes out (11-22 blind-reactions run)", () => {
  const held = new Set<string>();
  const result = "Yes, both pass, with 10 of 10 tests green.\n\n| Test file | Pass | Fail |\n|---|---|---|\n| `reactions.test.ts` | 6 | 0 |";
  assert.ok(tableEdit(result, held)?.startsWith(TABLE_EDIT_MARK));
  assert.equal(tableEdit(result, held), undefined, "the resend edits the post");
  assert.equal(tableEdit(MODEL_POST, new Set()), undefined, "a post with bullets and no table edits at once");
});

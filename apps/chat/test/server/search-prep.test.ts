/**
 * The values search builds before it asks Meilisearch are kept between searches (hidden threads and their filter, root chats, test sends),
 * and each follows its data at the next search: a thread that becomes hidden leaves it, a new test send leaves `from:owner`, and a thread
 * that becomes or stops being a root chat moves its hits' place. `conversation(id)` builds only the asked summary, the same as the thread's
 * full list gives.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/search-prep.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, SearchResult } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { DurableThread } from "../../server/host/types.ts";
import { filterText, type Cond } from "../../server/search-engine.ts";
import { start, until, type Running } from "./helpers.ts";

type FakeThread = ReturnType<FixtureHost["addThread"]>;

let s: Running;
let host: FixtureHost;
const filters: string[] = [];
before(async () => {
  s = await start();
  host = s.host as FixtureHost;
  const engine = s.app.searchEngine;
  const search = engine.search.bind(engine);
  engine.search = (q: string, where: Cond, opts, split) => {
    filters.push(filterText(where));
    return search(q, where, opts, split);
  };
});
after(() => s.close());

let clock = Date.now() - 60_000;
const say = (thread: FakeThread, text: string) => host.append(thread, 1, {
  kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: clock++ }],
});
const find = (q: string) => s.get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}&limit=100`);

test("a thread that becomes a test agent's leaves the next search, and comes back once it is no longer", async () => {
  const word = "prepwombat";
  const plain = host.addThread({ name: "Prep plain", createdAt: Date.now() - 3600_000 });
  const walk = host.addThread({ name: "Prep walk thread", createdAt: Date.now() - 3600_000 });
  say(plain, `the ${word} one`);
  say(walk, `the ${word} two`);
  say(walk, `the ${word} three`);
  await s.app.searchEngine.settled();
  assert.equal((await find(word)).total, 3);

  const made = await s.send<AgentSummary>("POST", "/api/agents", { name: "Prep walk agent", test: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  s.app.agents.alias(walk.row.id, made.body.id);
  assert.equal((await find(word)).total, 1, "the test agent's thread is still searched");
  await s.app.searchEngine.flagHidden();
  assert.equal((await find(word)).total, 1, "the marked thread came back");
  assert.ok(!filters.at(-1)!.includes(walk.row.id), "the filter still names the thread after its documents were marked");

  delete s.app.agentStore.agents.aliases[walk.row.id];
  s.app.agentStore.saveAgents();
  assert.equal((await find(word)).total, 3, "the thread that is no longer hidden is still left out");
});

test("a job's new test send leaves from:owner at the next search", async () => {
  const word = `preptapir${Date.now()}`;
  const text = `check ${word} please`;
  const submitted = await host.submit(ids.vent, { text, requestId: "prep-test-send" });
  const entry = host.threadsById.get(ids.vent)!.entries.find(e => e.kind === "pi.user" && JSON.stringify(e.model).includes(word))!;
  const at = Date.now();
  const { post } = s.app.agentStore.append({
    room: "dm_vent", author: "owner", text, images: [], at, requestId: "prep-test-send",
    delivery: { target: agents.vent, state: "delivered", attempts: 1, at, requestId: "prep-test-send", thread: ids.vent, submission: submitted.submission },
  });
  await s.app.searchEngine.settled();
  const owned = (await find(`${word} from:owner`)).hits.map(hit => hit.messageId);
  assert.ok(owned.includes(`e${entry.id}`), "the input is the owner's before it is marked");

  const marked = await s.send("PATCH", `/api/c/dm_vent/posts/${post.id}`, { testSend: { by: "prep job", reason: "It checked the DM." } });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  await until(async () => s.app.agentStore.postsOf("dm_vent").find(p => p.id === post.id)?.testSend?.entry, found => found === entry.id);
  const after = await find(`${word} from:owner`);
  assert.ok(!after.hits.some(hit => hit.messageId === `e${entry.id}`), "the test send still reads as the owner's");
  assert.equal(after.total, after.hits.length);
});

test("a thread that joins the list becomes a root chat, and one filed under an agent moves inside its work, at the next search", async () => {
  const word = "prepokapi";
  const chat = host.addThread({ name: "Prep root chat", createdAt: Date.now() - 3600_000 });
  say(chat, `the ${word} note`);
  await s.app.searchEngine.settled();
  const place = async () => (await find(word)).hits.find(hit => hit.conversation.id === chat.row.id)?.where;
  assert.equal(await place(), "tool", "a thread the list does not hold yet is no root chat");

  await s.app.threads.refresh();
  assert.equal(await place(), "root", "the listed thread is not a root chat");

  s.app.agents.fileJob(chat.row.id, s.app.agents.record(agents.vent)!);
  assert.equal(await place(), "tool", "the filed job still reads as a root chat");
});

test("a conversation's summary is the one its thread's full list holds", async () => {
  const threads = s.app.threads;
  const rows = (threads as unknown as { list: Map<string, DurableThread> }).list;
  const full = (row: DurableThread) => (threads as unknown as { rowConversations(row: DurableThread): unknown[] }).rowConversations(row);
  let jobs = 0;
  for (const row of rows.values()) {
    for (const summary of full(row) as { id: string; kind: string }[]) {
      assert.deepEqual(threads.conversation(summary.id), summary, summary.id);
      if (summary.id !== row.id) jobs += 1;
    }
    assert.deepEqual(threads.conversation(`${row.id}:9999`), threads.conversations().find(c => c.id === `${row.id}:9999`));
  }
  assert.ok(jobs > 0, "the fixture has no jobs to check");
});

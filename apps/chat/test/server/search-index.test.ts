/**
 * Search reads pi-host's index.sqlite on its own read-only connection, so it answers while pi-host is down or busy, with pi-host's
 * exact total, ranking, copy and channel-copy rules. After a restart on 2026-10-28, pi-host took 7 to 12 s to listen, and the owner's
 * first search waited for it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { ThreadIndex } from "../../../../packages/pi-host/src/durable/index-db.ts";
import { App } from "../../server/app.ts";
import { Meili, type MeiliTask } from "../../server/meili.ts";
import { CHANNEL_COPY_LIKE } from "../../server/group-rooms.ts";
import { readConfig } from "../../server/config.ts";
import { PiHost } from "../../server/host/pi-host.ts";
import { serve } from "../../server/http.ts";
import { writeJson } from "../../server/store.ts";

/**
 * How long after Meilisearch finished a send its documents may stay in memory: the drain polls the task at most 200 ms apart (meili.ts
 * `waitTask`) and reads the tasks once, and here it was done before the test's own wait for the task returned.
 */
const DRAIN_MS = 2_000;
const dir = mkdtempSync(join(tmpdir(), "apps-chat-index-"));
const indexPath = join(dir, "index.sqlite");
let index: ThreadIndex;
let app: App;
let server: ReturnType<typeof serve>;
let base = "";

before(async () => {
  index = new ThreadIndex(indexPath);
  for (const [id, archived] of [["old", true], ["live", false]] as const) {
    index.insertThread({ id, name: "vent", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
    if (archived) index.update(id, { archived: true });
    index.addEntries(id, Array.from({ length: 300 }, (_, i) => ({
      thread: id, conversation: 1, entryId: i + 1, kind: i % 2 ? "pi.assistant" : "pi.user", author: i % 2 ? "anthropic/claude-opus-5-5" : "owner",
      at: 1_000 + i, text: `zebra check ${i}${i % 3 ? "" : " zebra again"}`,
    })), []);
  }
  index.addEntries("live", [{
    thread: "live", conversation: 1, entryId: 301, kind: "agent.message", author: "owner", at: 2_000,
    text: "[#vent-dev · post 2 from You (owner) · your final answer is posted back into this thread]\n\n@vent zebra up?",
  }], []);
  // The last run's thread list, as the chat keeps it, so start() does not wait on the missing pi-host.
  const thread = (id: string, archived: boolean) => ({ id, name: "vent", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/",
    createdAt: 1, updatedAt: 1, failed: false, archived, preview: "", children: 0, status: "idle" });
  writeJson(join(dir, "data", "cache", "threads.json"), { threads: [thread("old", true), thread("live", false)], trees: [] });
  app = new App({ ...readConfig([]), dataDir: join(dir, "data"), port: 0, fixture: false, box: "test-box", durableIndex: indexPath }, new PiHost(join(dir, "no-pi-host.sock")), () => {});
  await app.start();
  await app.searchEngine.settled();
  server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await app.stop();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = async (q: string): Promise<{ ms: number; body: SearchResult }> => {
  const started = performance.now();
  const response = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  return { ms: performance.now() - started, body: (await response.json()) as SearchResult };
};

test("with pi-host down, search answers in under a second with pi-host's total and copy rules", async () => {
  const expected = index.search({ q: "zebra", limit: 20, skipAgentMessages: CHANNEL_COPY_LIKE });
  for (const read of ["first", "second"]) {
    const { ms, body } = await search("zebra");
    assert.ok(ms < 1000, `search from ${read} took ${ms.toFixed(0)} ms`);
    assert.equal(body.total, 300, read);
    assert.equal(body.total, expected.total, read);
    assert.equal(new Set(body.hits.map(h => h.messageId)).size, 20, read);
    assert.ok(body.hits.every(h => h.conversation.id === "live" && !h.snippet.includes("posted back")), read);
  }
});

test("a write pi-host commits after the chat opened the index shows in the next search", async () => {
  index.addEntries("live", [{ thread: "live", conversation: 1, entryId: 302, kind: "pi.user", author: "owner", at: 3_000, text: "a fresh okapi" }], []);
  const { body } = await search("okapi");
  assert.equal(body.total, 1);
  assert.equal(body.hits[0]!.messageId, "e302");
});

test("skipEntries leaves those entries out of the hits and the exact total, as from:owner does for the chat's test sends", () => {
  const owner = index.search({ q: "zebra", from: "owner", limit: 200 });
  const skipped = index.search({ q: "zebra", from: "owner", limit: 200, skipEntries: [{ thread: "live", entry: 1 }, { thread: "live", entry: 3 }] });
  assert.equal(skipped.total, owner.total - 2);
  assert.equal(skipped.hits.some(h => h.thread === "live" && (h.entryId === 1 || h.entryId === 3)), false);
});

test("rows pi-host writes while nobody searches leave memory once Meilisearch has them, so the first search after sends no id list", async t => {
  // On 11-08 the 8,270 rows of 27 h without a search waited in memory for the next one, which took 445 ms on :5184 (d2 duty, p95).
  const tasks: { meili: Meili; task: MeiliTask }[] = [];
  const filters: string[] = [];
  const { put, search: meiliSearch } = Meili.prototype;
  t.mock.method(Meili.prototype, "put", async function (this: Meili, uid: string, docs: string) {
    const task = await put.call(this, uid, docs);
    tasks.push({ meili: this, task });
    return task;
  });
  t.mock.method(Meili.prototype, "search", function (this: Meili, uid: string, body: Record<string, unknown>) {
    filters.push(String(body.filter));
    return meiliSearch.call(this, uid, body);
  });
  for (let i = 0; i < 20; i++) {
    index.addEntries("live", [{ thread: "live", conversation: 1, entryId: 400 + i, kind: "pi.user", author: "owner", at: 4_000 + i, text: `an idle wombat ${i}` }], []);
    await app.searchEngine.refresh();
  }
  const last = tasks.at(-1)!;
  await last.meili.waitTask(last.task);
  const pending = (app.searchEngine as unknown as { pending: Map<string, unknown> }).pending;
  const deadline = Date.now() + DRAIN_MS;
  while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pending.size, 0, `${pending.size} documents still wait in memory ${DRAIN_MS} ms after Meilisearch finished their last task`);
  const { body } = await search("wombat");
  assert.equal(body.total, 20);
  assert.equal(filters.length, 1);
  assert.doesNotMatch(filters[0]!, /\bid IN \["/);
});

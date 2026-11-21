/**
 * The filter an unscoped search sends Meilisearch names the rooms to keep, so it stays the same size however many test rooms walks make.
 * On 11-21 the 409 test rooms on us-metal02, named twice in the filter, cost 7 to 8 ms of each 22 ms search (step p156). A brief search
 * cuts no longer `text` for its hits, and its snippets match the full search's.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-filter-size.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Room, SearchResult } from "../../web/src/lib/api/types.ts";
import { filterText, type Cond } from "../../server/search-engine.ts";
import { start, type Running } from "./helpers.ts";

describe("search's filter and test rooms", () => {
  let s: Running;
  const filters: string[] = [];
  const word = "quokkafilterword";
  let plain: Room;
  const testRooms: Room[] = [];

  const room = async (name: string, test: boolean, text: string): Promise<Room> => {
    const made = (await s.send("POST", "/api/rooms", { kind: "channel", name, members: [], ...(test ? { test: true } : {}) })).body as Room;
    await s.send("POST", `/api/c/${made.id}/send`, { text, requestId: `${name}-1` });
    return made;
  };

  before(async () => {
    s = await start({ wordMs: 0 });
    const engine = s.app.searchEngine;
    const search = engine.search.bind(engine);
    engine.search = (q: string, where: Cond, opts) => {
      filters.push(filterText(where));
      return search(q, where, opts);
    };
    plain = await room("plain-room", false, `the plain ${word} ${"and a long tail of words ".repeat(20)}`);
  });
  after(() => s.close());

  test("test rooms leave the filter the same size and their posts out, and in: still finds them", async () => {
    const before = await s.get<SearchResult>(`/api/search?q=${word}`);
    const size = filters.at(-1)!.length;
    for (let i = 0; i < 12; i++) testRooms.push(await room(`walk-room-${i}`, true, `walk ${word} ${i}`));
    const found = await s.get<SearchResult>(`/api/search?q=${word}`);
    assert.equal(filters.at(-1)!.length, size, "each test room grew the filter");
    assert.ok(testRooms.every(r => !filters.at(-1)!.includes(r.id)));
    assert.deepEqual(found.hits.map(h => h.id), before.hits.map(h => h.id));
    assert.equal(found.total, before.total);
    assert.ok(found.hits.some(h => h.conversation.id === plain.id));
    const scoped = await s.get<SearchResult>(`/api/search?q=${word}&in=${testRooms[3]!.id}`);
    assert.deepEqual(scoped.hits.map(h => h.conversation.id), [testRooms[3]!.id]);
    assert.equal(scoped.total, 1);
  });

  test("a brief search's hits have the full search's snippets and no text", async () => {
    const full = await s.get<SearchResult>(`/api/search?q=${word}`);
    const brief = await s.get<SearchResult>(`/api/search?q=${word}&brief=1`);
    const long = full.hits.find(h => h.conversation.id === plain.id)!;
    assert.ok(long.text, "a post over 240 characters carries its longer text");
    assert.deepEqual(brief.hits, full.hits.map(({ text: _text, ...hit }) => hit));
  });
});

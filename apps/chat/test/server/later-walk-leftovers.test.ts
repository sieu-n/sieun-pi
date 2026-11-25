/**
 * A boot unsaves what finished walks left in Later (server/later.ts `dropWalkLeftovers`): every item of an archived test agent and each owner
 * item in an archived test room go, and the owner's real saves, his saves in a test room still open and a live test agent's saves stay. It
 * runs once with the lists in chat.sqlite (APPS_CHAT_DB_KINDS names later) and once in their JSON files.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/later-walk-leftovers.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LaterItem } from "../../web/src/lib/api/types.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

for (const kinds of ["later", ""]) {
  test(`a boot unsaves finished walks' items and keeps the rest (${kinds ? "chat.sqlite" : "JSON files"})`, async () => {
    const kept = process.env.APPS_CHAT_DB_KINDS;
    process.env.APPS_CHAT_DB_KINDS = kinds;
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-later-walks-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    const lines: string[] = [];
    const boot = (): Promise<Running> => start({ dataDir, host, log: line => lines.push(line) });
    try {
      let s = await boot();
      const room = async (name: string) => (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name, members: [], test: true })).body.id;
      const post = async (id: string) => (await s.send<{ item: { id: string } }>("POST", `/api/c/${id}/send`, { text: "walk post", requestId: crypto.randomUUID() })).body.item.id;
      const save = async (body: Record<string, unknown>) => {
        const res = await s.send<{ item: LaterItem; error?: string }>("POST", "/api/later", body);
        assert.equal(res.status, 200, res.body.error);
        return res.body.item.id;
      };
      const ended = await room("walk-ended");
      const live = await room("walk-live");
      const real = await save({ room: "dm_vent", post: (s.app.agentStore.postsOf("dm_vent").at(-1))!.id });
      const endedItem = await save({ room: ended, post: await post(ended) });
      const liveItem = await save({ room: live, post: await post(live) });
      const note = (await s.send<{ item: LaterItem }>("POST", "/api/later", { note: "call the bank" })).body.item.id;
      const agent = async (name: string) => (await s.send<{ id: string; thread: string }>("POST", "/api/agents", { name, test: true })).body;
      const gone = await agent("walk agent done");
      const running = await agent("walk agent running");
      const livePost = (await post(live));
      s.app.later.save(gone.id, { room: live, post: livePost });
      s.app.later.save(running.id, { room: live, post: livePost });
      assert.equal((await s.send("PATCH", `/api/rooms/${ended}`, { archived: true })).status, 200);
      assert.equal((await s.send("PATCH", `/api/c/${encodeURIComponent(gone.thread)}`, { archived: true })).status, 200);
      await s.close();

      s = await boot();
      assert.equal(s.app.agentStore.agentOf(gone.id)?.archived, true);
      assert.deepEqual(s.app.later.items("owner").map(i => i.id).sort(), [real, liveItem, note].sort(), "the item in the archived test room went");
      assert.deepEqual(s.app.later.items(gone.id), [], "the archived test agent's list is empty");
      assert.equal(s.app.later.items(running.id).length, 1, "a test agent still at work keeps its save");
      assert.ok(lines.some(line => line === "later: unsaved 2 items finished walks left"), lines.join("\n"));
      assert.ok(!s.app.later.items("owner").some(i => i.id === endedItem));
      await s.close();

      lines.length = 0;
      s = await boot();
      assert.equal(s.app.later.items("owner").length, 3, "the unsaves were stored");
      assert.ok(!lines.some(line => line.startsWith("later: unsaved")), "a second boot finds nothing to unsave");
      await s.close();
    } finally {
      if (kept === undefined) delete process.env.APPS_CHAT_DB_KINDS;
      else process.env.APPS_CHAT_DB_KINDS = kept;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

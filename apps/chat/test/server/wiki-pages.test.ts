/**
 * GET /api/pages (server/wiki/pages.ts) over a stub of the wiki engine's agent API: a title match leads, only pages are listed, and the
 * list with no words holds the favorites and the pages updated last without the session logs, kept and answered at once.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/wiki-pages.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRESH_MS, titleRank, WikiPageList } from "../../server/wiki/pages.ts";

const IDEAL = "agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html";

function engine(answers: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    async call(_method: string, path: string) {
      asked.push(path);
      const key = Object.keys(answers).find(prefix => path.startsWith(prefix));
      return key ? { status: 200, body: answers[key] } : { status: 404, body: { error: "no" } };
    },
  };
}

test("a page whose title is the query leads, past rows the engine ranked higher, and raw files stay out", async () => {
  const stub = engine({
    "/api/agent/search": {
      results: [
        { path: "domains/devops/x/raw/messages.txt", title: "Continual Harness State", updated: "2026-11-21" },
        { path: "domains/devops/x/channel-thread.html", title: "Channel reply prefill", description: "The context.", updated: "2026-11-21" },
        { path: IDEAL, title: "Ideal Slack replies in sw factory rooms", description: "Seventeen pairs.", updated: "2026-11-20" },
      ],
    },
  });
  const got = await new WikiPageList(stub).get("  ideal slack replies in SW factory rooms ");
  assert.deepEqual(got.pages.map(p => p.path), [IDEAL, "domains/devops/x/channel-thread.html"]);
  assert.equal(got.pages[0]!.description, "Seventeen pairs.");
  assert.deepEqual(got.favorites, []);
  assert.match(stub.asked[0]!, /includeSessions=true/);
});

test("titleRank orders the exact title, a prefix, every word, then any match", () => {
  assert.deepEqual(["Agent memory", "Agent memory review", "Memory of an agent", "Work queue"].map(t => titleRank(t, "agent memory")), [0, 1, 2, 3]);
});

test("with no words it lists the favorites by title and the recent pages without session logs", async () => {
  const stub = engine({
    "/api/agent/favorites": { favorites: ["apps/crawler-v3/platform-parity.html", "gone/page.html"] },
    "/api/agent/find?glob=apps": { results: [{ path: "apps/crawler-v3/platform-parity.html", title: "Platform parity", updated: "2026-11-01" }] },
    "/api/agent/recent": {
      results: [
        { path: "sessions/2026/11/22/0537-p133-walk/index.html", title: "p133 walk", updated: "2026-11-22" },
        { path: "domains/devops/sw-factory-threads/index.html", title: "sw factory threads", updated: "2026-11-21" },
        { path: "sessions/2026/11/22/0537-p133-walk/notes.json", title: "Notes", updated: "2026-11-21" },
      ],
    },
  });
  const got = await new WikiPageList(stub).get("");
  assert.deepEqual(got.favorites.map(p => p.title), ["Platform parity"]);
  assert.deepEqual(got.pages.map(p => p.path), ["domains/devops/sw-factory-threads/index.html"]);
});

test("an engine that does not answer is an error the route reports", async () => {
  await assert.rejects(new WikiPageList(engine({})).get("memory"), /answered 404/);
});

test("the list with no words is answered from the last read, and an older one is read again behind the answer", async () => {
  let clock = 0;
  const recent: { path: string; title: string; updated: string }[] = [{ path: "domains/a.html", title: "A", updated: "2026-11-24" }];
  let release = (): void => undefined;
  let held = false;
  const stub = {
    asked: [] as string[],
    async call(_method: string, path: string) {
      stub.asked.push(path.split("?")[0]!);
      if (path.startsWith("/api/agent/favorites")) return { status: 200, body: { favorites: [] } };
      if (held) await new Promise<void>(resolve => (release = resolve));
      return { status: 200, body: { results: recent.map(row => ({ ...row })) } };
    },
  };
  const list = new WikiPageList(stub, () => clock);
  const first = await list.get("", 50);
  assert.deepEqual(first.pages.map(p => p.path), ["domains/a.html"]);
  assert.equal(first.refreshing, false);

  // A second call within FRESH_MS asks the engine nothing.
  const reads = stub.asked.length;
  clock = FRESH_MS - 1;
  assert.equal((await list.get("", 50)).refreshing, false);
  assert.equal(stub.asked.length, reads);

  // A page written since shows in the answer after the read behind an older list; the call that starts that read does not wait for it.
  recent.unshift({ path: "domains/new.html", title: "New", updated: "2026-11-24" });
  held = true;
  clock = FRESH_MS;
  const behind = await list.get("", 50);
  assert.deepEqual(behind.pages.map(p => p.path), ["domains/a.html"]);
  assert.equal(behind.refreshing, true);
  held = false;
  release();
  await new Promise(resolve => setImmediate(resolve));
  const after = await list.get("", 1);
  assert.deepEqual(after.pages.map(p => p.path), ["domains/new.html"]);
  assert.equal(after.refreshing, false);
});

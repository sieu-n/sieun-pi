/**
 * GET /api/pages (server/wiki/pages.ts) over a stub of the wiki engine's agent API: a title match leads, only pages are listed, and the
 * list with no words holds the favorites and the pages updated last without the session logs.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/wiki-pages.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { titleRank, wikiPages } from "../../server/wiki/pages.ts";

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
  const got = await wikiPages(stub, "  ideal slack replies in SW factory rooms ");
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
  const got = await wikiPages(stub, "");
  assert.deepEqual(got.favorites.map(p => p.title), ["Platform parity"]);
  assert.deepEqual(got.pages.map(p => p.path), ["domains/devops/sw-factory-threads/index.html"]);
});

test("an engine that does not answer is an error the route reports", async () => {
  await assert.rejects(wikiPages(engine({}), "memory"), /answered 404/);
});

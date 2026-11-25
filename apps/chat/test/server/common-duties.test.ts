/**
 * Every new agent gets the two common duties of c249 (#sw-factory-build p234): the check-in every 3 hours as its board push, and the daily
 * "Area review" duty, whose precheck (scripts/duties/area-review.ts) hands the review to a duty job each day. A walk's test agent gets the
 * review paused, so a throwaway agent starts no daily job.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/common-duties.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, CheckInView, DutyRow } from "../../web/src/lib/api/types.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AREA_REVIEW_NAME, areaReviewDuty, areaReviewUpdate, BOARD_PUSH_EVERY_MS, hostCwd, liveAppDir } from "../../server/common-duties.ts";
import { areaReview } from "../../scripts/duties/area-review.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let fresh: AgentSummary;
let throwaway: AgentSummary;

before(async () => {
  s = await start({ wordMs: 0 });
  fresh = (await s.send("POST", "/api/agents", { name: "fresh agent" })).body;
  throwaway = (await s.send("POST", "/api/agents", { name: "walk throwaway", test: true })).body;
});
after(async () => {
  await s.close();
});

const duties = async (agent: AgentSummary) => (await s.get<{ duties: DutyRow[] }>(`/api/agents/${agent.id}/duties`)).duties;

test("a new agent has the daily Area review duty and a check-in every 3 hours from its start", async () => {
  const review = (await duties(fresh)).filter(row => row.duty.name === AREA_REVIEW_NAME);
  assert.equal(review.length, 1);
  assert.equal(review[0]!.paused, false);
  assert.match(review[0]!.duty.ownerWords, /every 3 hour push completing tasks in the TODO board[\s\S]*p234/);
  const stored = s.app.boards.dutyFile(fresh.id).duties.find(d => d.name === AREA_REVIEW_NAME)!;
  assert.equal(stored.schedule.kind, "daily");
  assert.deepEqual(stored.precheck.command, ["node", `${liveAppDir()}/scripts/duties/area-review.ts`, "--agent", fresh.id]);
  // With no open step the view reads the daily interval as everyMs and the setting as planEveryMs (boards.ts `checkIn`).
  const view = await s.get<CheckInView>(`/api/agents/${fresh.id}/check-in`);
  assert.equal(view.planEveryMs ?? view.everyMs, BOARD_PUSH_EVERY_MS);
  assert.equal(BOARD_PUSH_EVERY_MS, 180 * 60_000);
});

test("a walk's test agent shows the Area review duty paused", async () => {
  const review = (await duties(throwaway)).filter(row => row.duty.name === AREA_REVIEW_NAME);
  assert.equal(review.length, 1);
  assert.equal(review[0]!.paused, true);
});

test("the duty runs where the chat host keeps the agent's project: a metal agent's own folder, a Mac path's copy under this box's home, else apps/chat", () => {
  const home = mkdtempSync(join(tmpdir(), "common-duties-home-"));
  const repo = join(home, "Documents/Github/auto-sns-agent");
  mkdirSync(repo, { recursive: true });
  try {
    // A us-metal02 agent such as seo: its home is a folder on this box.
    const metal = areaReviewDuty("ag_seo", repo, "/app", home) as { precheck: { cwd: string; command: string[] } };
    assert.equal(metal.precheck.cwd, repo);
    assert.deepEqual(metal.precheck.command, ["node", "/app/scripts/duties/area-review.ts", "--agent", "ag_seo"]);
    // A Mac agent such as 5180 designer, or vent with its Mac home: the same repo under this box's home.
    const mac = areaReviewDuty("ag_5180-designer", "/Users/sieunpark/Documents/Github/auto-sns-agent", "/app", home) as { precheck: { cwd: string } };
    assert.equal(mac.precheck.cwd, repo);
    assert.equal(hostCwd("/Users/sieunpark/Documents/Github/nothing-here", "/app", home), "/app");
    assert.equal(hostCwd(undefined, "/app", home), "/app");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a backfill or rerun keeps an agent's own Area review whole and moves only a cwd the chat host lacks (API portal's d7, 42b2a65e9)", () => {
  const home = mkdtempSync(join(tmpdir(), "common-duties-keep-"));
  const repo = join(home, "src/sieun-pi");
  mkdirSync(repo, { recursive: true });
  try {
    const own = { name: AREA_REVIEW_NAME, ownerWords: "his words", goal: "the portal's own review", onMiss: "act",
      metrics: [{ key: "portal_errors", label: "Errors", op: "<=", target: 0 }], precheck: { command: ["node", "--import", "tsx", "scripts/duties/portal-area-review.ts"], cwd: repo, timeoutMs: 120_000 } };
    assert.equal(areaReviewUpdate(own, "ag_api-portal", repo, "/app", home), null, "a review whose cwd this box has stays as it is");
    const moved = areaReviewUpdate({ ...own, precheck: { ...own.precheck, cwd: "/Users/sieunpark/src/sieun-pi" } }, "ag_api-portal", repo, "/app", home) as typeof own;
    assert.deepEqual(moved, { ...own, precheck: { ...own.precheck, cwd: repo } });
    const fresh = areaReviewUpdate(undefined, "ag_new", repo, "/app", home) as { name: string; precheck: { command: string[] } };
    assert.equal(fresh.name, AREA_REVIEW_NAME);
    assert.deepEqual(fresh.precheck.command, ["node", "/app/scripts/duties/area-review.ts", "--agent", "ag_new"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the area review always hands off the review, counts corrections its memory misses, and the owner's posts of the day to it", () => {
  const now = Date.parse("2026-11-26T00:00:00Z");
  const review = areaReview({
    agent: { id: "ag_seo", slug: "seo", name: "seo", room: "dm_seo" },
    corrections: [
      { id: "c10", rule: "Saved rule.", chat: { name: "seo · dm_seo" } },
      { id: "c11", rule: "Unsaved rule.", chat: { name: "seo · #seo" } },
      { id: "c12", rule: "Another agent's rule.", chat: { name: "seo guy · #x" } },
      { id: "c13", rule: "Retired rule.", status: "retired", chat: { name: "seo · #seo" } },
    ],
    memory: { a: { title: "Rule", content: "Owner rule c10: keep titles short.", updated_at: "2026-11-25T12:00:00Z" }, b: { content: "old", updated_at: "2026-11-01T00:00:00Z" } },
    posts: [
      { room: "dm_seo", id: "p1", author: "owner", text: "why is this broken again", at: now - 3600_000 },
      { room: "ch_1", id: "p2", author: "owner", text: "@seo check this", at: now - 3600_000, mentions: ["ag_seo"] },
      { room: "ch_1", id: "p3", author: "owner", text: "for someone else", at: now - 3600_000, mentions: ["ag_vent"] },
      { room: "dm_seo", id: "p4", author: "owner", text: "yesterday's", at: now - 2 * 86_400_000 },
      { room: "dm_seo", id: "p5", author: "ag_seo", text: "an agent post", at: now - 60_000 },
    ],
    folderTimes: [{ path: "/a/seo/notes.html", mtimeMs: now - 60_000 }, { path: "/a/seo/old.md", mtimeMs: now - 3 * 86_400_000 }, { path: "/a/seo/x.json", mtimeMs: now }],
    now,
  });
  // p5, the agent's DM post after p1, answers p1, so only p2 counts (owner_posts_answered_24h).
  assert.deepEqual(review.metrics, { corrections_unsaved: 1, owner_posts_24h: 1, owner_posts_answered_24h: 1, wiki_pages_touched_24h: 1, memory_changed_24h: 1 });
  assert.equal(review.flagged[0]!.kind, "area_review");
  assert.equal(review.flagged[0]!.handOff, true);
  assert.deepEqual(review.flagged.slice(1).map(f => f.sig), ["c11", "dm_seo/p1", "ch_1/p2"]);
});

/**
 * Agent factory's d5 precheck (scripts/duties/agent-boards.ts) sums every agent's stuck steps and goal gaps from GET /steps, flags each one
 * with why it is stuck, and counts a check-in with no run in 1.5 intervals as late unless it is paused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-boards.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBoards, dutyCoverage, liveDuty, readAreas, type DutyRow } from "../../scripts/duties/agent-boards.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-11-24T00:00:00Z");
const HOUR = 3_600_000;

test("stuck steps and gaps sum over agents, each flagged with why, and only an unpaused check-in past 1.5 intervals is late", () => {
  const out = agentBoards([
    {
      agent: { id: "ag_seo", name: "seo" },
      steps: { open: 3, stuck: [{ id: "p143", text: "Publish the December batch", status: "blocked", waitUntil: "2026-12-01T00:00:00Z" }], gaps: [{ id: "p2", text: "Clicks reach 1k a day" }] },
      checkIn: { everyMs: 2 * HOUR, paused: false, lastAt: NOW - 4 * HOUR, runs: [{ at: NOW - 4 * HOUR, verdict: "missed", summary: "" }] },
    },
    {
      agent: { id: "ag_vent", name: "vent" },
      steps: { open: 2, stuck: [{ id: "p9", text: "Rotate the key", status: "todo", job: "key rotation" }], gaps: [] },
      checkIn: { everyMs: 6 * HOUR, paused: false, lastAt: NOW - HOUR },
    },
    { agent: { id: "ag_mcp", name: "mcp" }, steps: { open: 0, stuck: [], gaps: [] }, checkIn: { everyMs: 2 * HOUR, paused: true, lastAt: NOW - 30 * HOUR } },
  ], NOW);
  assert.deepEqual(out.metrics, { stuck_steps_all: 2, goal_gaps_all: 1, checkins_late: 1, open_steps_all: 5 });
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.sig]), [
    ["stuck_step", "ag_seo/p143"], ["goal_gap", "ag_seo/p2"], ["checkin_late", `ag_seo/checkin/${NOW - 4 * HOUR}`], ["stuck_step", "ag_vent/p9"],
  ]);
  assert.match(out.flagged[0]!.excerpt, /no job, waits until 2026-12-01/);
  assert.match(out.flagged[3]!.excerpt, /job key rotation not at work/);
});


const duty = (id: string, name: string, runs: string[], paused = false): DutyRow => ({ duty: { id, name, status: paused ? "paused" : "active" }, paused, runs: runs.map(verdict => ({ verdict })) });

test("a duty is live only when it is not paused and has a run that measured something", () => {
  assert.equal(liveDuty(duty("d1", "Prod MCP", ["met"])), true);
  assert.equal(liveDuty(duty("d1", "Prod MCP", ["missed"], true)), false);
  assert.equal(liveDuty(duty("d1", "Prod MCP", [])), false);
  assert.equal(liveDuty(duty("d1", "Prod MCP", ["skipped"])), false);
});

test("agents with no live duty, or with an area no live duty watches, are uncovered and each is named once", () => {
  const out = dutyCoverage([
    { agent: { id: "ag_mcp", name: "mcp" }, duties: [duty("d1", "Prod MCP", ["met"])] },
    { agent: { id: "ag_api-portal", name: "API portal" }, duties: [] },
    { agent: { id: "ag_crawler-guy", name: "Crawler guy" }, duties: [duty("d1", "Crawler read cost", ["met"]), duty("d6", "Meta Ads crawl", ["missed"], true)] },
    { agent: { id: "ag_gpt-guy", name: "gpt guy" }, duties: [duty("d1", "New duty", [])] },
    { agent: { id: "ag_seo", name: "seo" }, duties: [duty("d1", "Search traffic", ["met"])] },
  ], [
    { agent: "ag_crawler-guy", areas: [{ area: "Read cost", duty: "d1" }, { area: "Meta Ads", source: "msg mw1", duty: "d6" }, { area: "TikTok parity", source: "msg mw2" }] },
    { agent: "seo", areas: [{ area: "Search traffic", duty: "Search traffic" }] },
  ]);
  assert.deepEqual(out.metrics, { agents_uncovered: 3, areas_uncovered: 2 });
  assert.deepEqual(out.flagged.map(flag => flag.item), ["ag_api-portal", "ag_crawler-guy", "ag_gpt-guy"]);
  assert.match(out.flagged[0]!.excerpt, /API portal \(ag_api-portal\): no duty/);
  assert.match(out.flagged[1]!.excerpt, /area "Meta Ads" \(msg mw1\) has duty d6, not live; area "TikTok parity" \(msg mw2\) has no duty/);
  assert.match(out.flagged[2]!.excerpt, /no live duty \(d1 never ran\)/);
});

test("the areas file is optional and a malformed one throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "areas-"));
  assert.deepEqual(readAreas(join(dir, "none.json")), []);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ agent: "seo" }));
  assert.throws(() => readAreas(join(dir, "bad.json")), /not a list/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify([{ agent: "seo", areas: [{ area: "Search traffic", source: "brief", duty: "d1" }] }]));
  assert.equal(readAreas(join(dir, "ok.json"))[0]!.areas[0]!.duty, "d1");
  writeFileSync(join(dir, "keyed.json"), JSON.stringify({ _note: "light read", "ag_gpt-guy": { missing: [{ area: "repo free of slop", source: "dm_gpt-guy p1" }], note: "x" } }));
  assert.deepEqual(readAreas(join(dir, "keyed.json")), [{ agent: "ag_gpt-guy", areas: [{ area: "repo free of slop", source: "dm_gpt-guy p1" }] }]);
  writeFileSync(join(dir, "keyed-bad.json"), JSON.stringify({ "ag_gpt-guy": { missing: [{ what: "x" }] } }));
  assert.throws(() => readAreas(join(dir, "keyed-bad.json")), /not a list/);
});

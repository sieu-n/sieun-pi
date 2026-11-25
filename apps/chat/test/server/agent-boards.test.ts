/**
 * Agent factory's d5 precheck (scripts/duties/agent-boards.ts) sums every agent's stuck steps and goal gaps from GET /steps, flags each one
 * with why it is stuck, and counts a check-in with no run in 1.5 intervals as late unless it is paused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-boards.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBoards, dutyCoverage, liveDuty, overdueDuty, readAreas, type DutyRow } from "../../scripts/duties/agent-boards.ts";
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
    { agent: { id: "ag_api-portal", name: "API portal" }, duties: [], brief: "Keep api.virev.ai up." },
    { agent: { id: "ag_crawler-guy", name: "Crawler guy" }, duties: [duty("d1", "Crawler read cost", ["met"]), duty("d6", "Meta Ads crawl", ["missed"], true)] },
    { agent: { id: "ag_gpt-guy", name: "gpt guy" }, duties: [duty("d1", "New duty", [])], brief: "Keep the repo clean." },
    { agent: { id: "ag_seo", name: "seo" }, duties: [duty("d1", "Search traffic", ["met"])] },
  ], [
    { agent: "ag_crawler-guy", areas: [{ area: "Read cost", duty: "d1" }, { area: "Meta Ads", source: "msg mw1", duty: "d6" }, { area: "TikTok parity", source: "msg mw2" }] },
    { agent: "seo", areas: [{ area: "Search traffic", duty: "Search traffic" }] },
  ]);
  assert.deepEqual(out.metrics, { agents_uncovered: 3, areas_uncovered: 2, agents_without_area: 0, duties_paused: 1, duties_overdue: 0 });
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "uncovered_agent").map(flag => flag.item), ["ag_api-portal", "ag_crawler-guy", "ag_gpt-guy"]);
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "duty_paused").map(flag => flag.sig), ["ag_crawler-guy/d6/paused"]);
  const uncovered = out.flagged.filter(flag => flag.kind === "uncovered_agent");
  assert.match(uncovered[0]!.excerpt, /API portal \(ag_api-portal\): no duty/);
  assert.match(uncovered[1]!.excerpt, /area "Meta Ads" \(msg mw1\) has duty d6, not live; area "TikTok parity" \(msg mw2\) has no duty/);
  assert.match(uncovered[2]!.excerpt, /no live duty \(d1 never ran\)/);
});

test("a duty with no run for over 2 of its intervals is overdue and not live, and each paused or overdue duty is listed per agent", () => {
  const every = (id: string, minutes: number, lastAt: number | null, paused = false): DutyRow => ({
    duty: { id, name: id, status: paused ? "paused" : "active" }, paused, runs: lastAt === null ? [] : [{ verdict: "met", at: lastAt }],
    schedule: { kind: "every", minutes }, nextAt: paused ? null : (lastAt ?? NOW - 10 * HOUR) + minutes * 60_000,
  });
  const daily = (id: string, lastAt: number): DutyRow => ({ duty: { id, name: id, status: "active" }, paused: false, runs: [{ verdict: "met", at: lastAt }], schedule: { kind: "daily", at: "07:00" }, nextAt: lastAt + 24 * HOUR });
  assert.equal(overdueDuty(every("d1", 180, NOW - 5 * HOUR), NOW), false);
  assert.equal(overdueDuty(every("d1", 180, NOW - 7 * HOUR), NOW), true);
  assert.equal(overdueDuty(daily("d2", NOW - 47 * HOUR), NOW), false);
  assert.equal(overdueDuty(daily("d2", NOW - 49 * HOUR), NOW), true);
  assert.equal(liveDuty(daily("d2", NOW - 49 * HOUR), NOW), false);
  const out = dutyCoverage([
    { agent: { id: "ag_vent", name: "vent" }, duties: [daily("d1", NOW - 3 * HOUR), daily("d2", NOW - 72 * HOUR)], brief: "Vent gateway" },
    { agent: { id: "ag_mcp", name: "mcp" }, duties: [daily("d1", NOW - 50 * HOUR), every("d2", 60, null, true), every("d3", 60, null)], brief: "Prod MCP" },
  ], [], NOW);
  assert.deepEqual(out.metrics, { agents_uncovered: 1, areas_uncovered: 0, agents_without_area: 0, duties_paused: 1, duties_overdue: 3 });
  assert.deepEqual(out.flagged.map(flag => flag.sig), ["ag_vent/d2/overdue", "ag_mcp/d1/overdue", "ag_mcp/d2/paused", "ag_mcp/d3/overdue", "ag_mcp/duties"]);
  assert.match(out.flagged[0]!.excerpt, /vent d2 "d2" has no run for 72 h, due 48 h ago/);
  assert.match(out.flagged[3]!.excerpt, /mcp d3 "d3" has no run since it was made/);
  assert.match(out.flagged[4]!.excerpt, /no live duty \(d1 overdue, d2 paused, d3 overdue\)/);
});

test("an agent with no brief and no area from the owner has no area, so it is left out of the gap count and listed apart", () => {
  const out = dutyCoverage([
    { agent: { id: "ag_feature-probe", name: "feature probe" }, duties: [] },
    { agent: { id: "ag_api-portal", name: "API portal" }, duties: [], brief: "# API portal\nKeep api.virev.ai up." },
    { agent: { id: "ag_gpt-guy", name: "gpt guy" }, duties: [], brief: "  " },
  ], [
    { agent: "ag_gpt-guy", areas: [{ area: "repo free of slop", source: "dm_gpt-guy p1" }] },
    { agent: "ag_feature-probe", areas: [{ area: "whatever area you were made for", source: "none found" }] },
  ]);
  assert.deepEqual(out.metrics, { agents_uncovered: 2, areas_uncovered: 1, agents_without_area: 1, duties_paused: 0, duties_overdue: 0 });
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.item]), [["no_area", "ag_feature-probe"], ["uncovered_agent", "ag_api-portal"], ["uncovered_agent", "ag_gpt-guy"]]);
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

/**
 * Agent factory's d5 precheck (scripts/duties/agent-boards.ts) sums every agent's stuck steps and goal gaps from GET /steps, flags each one
 * with why it is stuck, and counts a check-in with no run in 1.5 intervals as late unless it is paused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-boards.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_REVIEW_N_SINCE, agentBoards, agentPattern, askHeld, asksTo, duplicateJobs, ongoingAsk, dutyCoverage, liveDuty, overdueDuty, pauseReason, planOpenSince, readAreas, readAsks, readWiki, sampleSize, stalePause,
  unfixedMisses, wikiClutter,
  type Ask, type DutyRow,
} from "../../scripts/duties/agent-boards.ts";
import {
  JOB_WAITS_ACCOUNT, NOT_MEASURED, PRECHECK_FAILED, blindChecks, dutySystemFaults, fixCloses, heldJobs, readPastProblems, readReturns, readsOf, replay, returningProblems, returnsOf, runFile,
  type PastProblem,
} from "../../scripts/duties/duty-health.ts";
import { judge, type DutyMetric } from "../../web/src/lib/api/shared/chat-duties.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.equal(out.n, 3, "n is the agents read");
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
    { agent: { id: "ag_mcp", name: "mcp" }, duties: [duty("d1", "Prod MCP", ["met"])], brief: "Prod MCP" },
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


test("c249: each agent with an area keeps a 3-hourly board push and a daily Area review that run on time and produce work, and gets one nudge", () => {
  const review = (lastAt: number | null, extra: Partial<DutyRow["runs"][number]> = {}): DutyRow => ({
    duty: { id: "d9", name: "Area review", status: "active" }, paused: false,
    runs: lastAt === null ? [] : [{ verdict: "met", at: lastAt, metrics: { corrections_unsaved: { value: 0 } }, ...extra }], schedule: { kind: "daily", at: "07:00" }, nextAt: (lastAt ?? NOW - HOUR) + 24 * HOUR,
  });
  const push = (everyMin: number, lastAt: number | null, paused = false) => ({ everyMs: everyMin * 60_000, planEveryMs: everyMin * 60_000, paused, lastAt, runs: lastAt === null ? [] : [{ at: lastAt }] });
  const out = agentPattern([
    // On the pattern: 180 min push that ran, a review whose run started a job.
    { agent: { id: "ag_seo", name: "seo", thread: "t-seo" }, brief: "SEO", duties: [review(NOW - 3 * HOUR, { job: { id: "j1" } })], checkIn: push(180, NOW - HOUR), stuck: 2, boardAt: NOW - 2 * HOUR },
    // Push at 120 min is fine too; review that only wrote wiki pages produced work.
    { agent: { id: "ag_vent", name: "vent", thread: "t-vent" }, brief: "Vent", duties: [review(NOW - 3 * HOUR, { readings: { wiki_pages_touched_24h: 2, memory_changed_24h: 0 } })], checkIn: push(120, NOW - HOUR), stuck: 0, boardAt: NOW - 50 * HOUR },
    // Off: push every 360 min, no Area review.
    { agent: { id: "ag_mcp", name: "mcp", thread: "t-mcp" }, brief: "MCP", duties: [duty("d1", "Prod MCP", ["met"])], checkIn: push(360, NOW - HOUR) },
    // Off: push late, board stuck and unchanged, review ran empty.
    { agent: { id: "ag_crawler-guy", name: "Crawler guy", thread: "t-crawler" }, brief: "Crawler", duties: [review(NOW - 3 * HOUR, { readings: { wiki_pages_touched_24h: 0, memory_changed_24h: 0 } })], checkIn: push(180, NOW - 7 * HOUR), stuck: 3, boardAt: NOW - 30 * HOUR },
    // No area: left out of every count.
    { agent: { id: "ag_feature-probe", name: "feature probe", thread: "t-fp" }, duties: [], checkIn: push(1440, null) },
  ], [], NOW);
  assert.deepEqual(out.metrics, {
    agents_off_pattern: 2, common_duties_missing: 2, common_duties_late: 1, empty_runs: 2,
    agents_uncovered: 0, areas_uncovered: 0, agents_without_area: 1, duties_paused: 0, duties_overdue: 0, asks_unheld: 0, asks_unsorted: 0, pauses_stale: 0, met_on_zero: 0,
    runs_without_n: 0, duplicate_jobs: 0, duties_stopped: 0,
  });
  assert.deepEqual(out.flagged.filter(flag => flag.kind !== "no_area").map(flag => [flag.kind, flag.sig]), [
    ["common_missing", "ag_mcp/push"], ["common_missing", "ag_mcp/review"],
    ["common_late", "ag_crawler-guy/push/late"], ["empty_run", "ag_crawler-guy/push/empty"], ["empty_run", "ag_crawler-guy/review/d9/empty"],
  ]);
  assert.deepEqual(out.messages.map(message => [message.agent, message.workThreadId]), [["ag_mcp", "t-mcp"], ["ag_crawler-guy", "t-crawler"]]);
  assert.match(out.messages[0]!.text, /c249[\s\S]*1\. its check-in, the board push, runs every 360 min[\s\S]*2\. it has no daily "Area review" duty/);
  assert.match(out.messages[1]!.text, /3\. its d9 "Area review" ran with no job, no wiki page and no memory change/);
});

test("an Area review counts by its name whatever script its precheck runs, and a run whose box was away is skipped", () => {
  const push = { everyMs: 180 * 60_000, planEveryMs: 180 * 60_000, paused: false, lastAt: NOW - HOUR, runs: [{ at: NOW - HOUR }] };
  // API portal's own precheck (portal-area-review.ts) adds readings of its own next to the shared ones.
  const portal: DutyRow = {
    duty: { id: "d7", name: "Area review", status: "active" }, paused: false, schedule: { kind: "daily", at: "06:10" }, nextAt: NOW + 20 * HOUR,
    runs: [{ verdict: "missed", at: NOW - 3 * HOUR, metrics: { issues_not_acted_on: { value: 12 } }, readings: { corrections_unsaved: 0, stale_pages: 12 }, job: { id: "j" } }],
  };
  const away: DutyRow = { ...portal, duty: { ...portal.duty, id: "d2" }, runs: [{ verdict: "error", at: NOW - 3 * HOUR, metrics: {}, hostAway: "mac" }] };
  const out = agentPattern([
    { agent: { id: "ag_api-portal", name: "API portal" }, brief: "Portal", duties: [portal], checkIn: push, outputs: { d7: true }, samples: { d7: 13 } },
    { agent: { id: "ag_5180-designer", name: "5180 designer" }, brief: "5180", duties: [away], checkIn: push },
  ], [], NOW);
  assert.deepEqual(out.flagged.filter(flag => ["common_missing", "empty_run", "met_on_zero"].includes(flag.kind)), []);
  assert.equal(out.metrics.common_duties_missing, 0);
});

test("an Area review run that wrote no output is empty, even when the failed run started a job", () => {
  const failed: DutyRow = {
    duty: { id: "d3", name: "Area review", status: "active" }, paused: false, schedule: { kind: "daily", at: "07:00" }, nextAt: NOW + 20 * HOUR,
    runs: [{ verdict: "error", at: NOW - 4 * HOUR, metrics: {}, job: { id: "j1" }, detail: "/x/d3-261126-053949.stderr.log" }],
  };
  const met: DutyRow = { ...failed, runs: [{ verdict: "met", at: NOW - 4 * HOUR, metrics: { corrections_unsaved: { value: 0 } }, job: { id: "j2" } }] };
  const push = { everyMs: 180 * 60_000, planEveryMs: 180 * 60_000, paused: false, lastAt: NOW - HOUR, runs: [{ at: NOW - HOUR }] };
  const out = agentPattern([
    { agent: { id: "ag_vp-of-gtm", name: "VP of GTM" }, brief: "GTM", duties: [failed], checkIn: push },
    { agent: { id: "ag_seo", name: "seo" }, brief: "SEO", duties: [met], checkIn: push, outputs: { d3: false } },
    { agent: { id: "ag_vent", name: "vent" }, brief: "Vent", duties: [met], checkIn: push, outputs: { d3: true } },
  ], [], NOW);
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "empty_run").map(flag => flag.excerpt), [
    'VP of GTM: its d3 "Area review" wrote no output (the precheck failed), so it reviewed nothing',
    'seo: its d3 "Area review" wrote no output, so it reviewed nothing',
  ]);
  assert.equal(out.metrics.empty_runs, 2);
});


test("wiki clutter: agent folders of no live agent, and dated one-off pages no curated page links to, each listed by path", () => {
  const out = wikiClutter(["seo", "vent", "TEMPLATE", ".git", "blind-replies-1121214520pe", "blind-moved-112512080674", "old-agent"], new Set(["seo", "vent"]), [
    { path: "domains/devops/index.html", text: '<a href="duty-failures-2026-10-18.html">Duty failures</a> <a href="railway-breach-2026-10-21/index.html">breach</a>' },
    { path: "domains/devops/duty-failures-2026-10-18.html", text: '<a href="queue-waits-2026-10-15.html">waits</a>' },
    { path: "domains/devops/queue-waits-2026-10-15.html", text: "" },
    { path: "domains/devops/railway-breach-2026-10-21/index.html", text: "" },
    { path: "domains/devops/railway-breach-2026-10-21/service-checks/index.html", text: "" },
    { path: "domains/devops/root-free-space-2026-10-25-0156/index.html", text: "" },
    { path: "domains/devops/root-free-space-2026-10-25-0156/data.md", text: "" },
    { path: "apps/chat/d7-261126-052811.html", text: "" },
    { path: "apps/chat/index.html", text: '<a href="wiki:apps/chat/push-jobs.html">jobs</a>' },
    { path: "apps/chat/push-jobs.html", text: "" },
  ]);
  assert.deepEqual(out.metrics, { wiki_clutter: 6, orphan_agent_folders: 3, dated_pages: 3 });
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.item]), [
    ["orphan_agent_folder", "agents/blind-moved-112512080674"], ["orphan_agent_folder", "agents/blind-replies-1121214520pe"], ["orphan_agent_folder", "agents/old-agent"],
    ["dated_page", "apps/chat/d7-261126-052811.html"], ["dated_page", "domains/devops/queue-waits-2026-10-15.html"], ["dated_page", "domains/devops/root-free-space-2026-10-25-0156"],
  ]);
  assert.match(out.flagged[5]!.excerpt, /root-free-space-2026-10-25-0156 \(2 pages\) is a dated one-off page/);
});

test("wiki clutter skips a dated page that moved away, which leaves only a redirect stub, and the kept harness-keeper folder", () => {
  const stub = (to: string) => `<!--wiki\n${JSON.stringify({ title: "Root free space", moved_to: to, superseded_by: to })}\n-->\n<h1>Root free space</h1>\n`;
  const out = wikiClutter(["harness-keeper", "seo"], new Set(["seo"]), [
    { path: "domains/devops/root-free-space-2026-10-25/index.html", text: stub("archive/domains/devops/root-free-space-2026-10-25/index.html") },
    { path: "domains/devops/queue-waits-2026-10-15.html", text: "<h1>Queue waits</h1>" },
  ]);
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.item]), [["dated_page", "domains/devops/queue-waits-2026-10-15.html"]]);
});

test("readWiki reads the agents mount and the curated folders named in wiki.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const content = join(dir, "content");
  const agents = join(dir, "agents");
  for (const folder of [join(content, "domains/devops/x-2026-10-15"), join(content, "experiments/2026-08-16-a"), join(agents, "seo"), join(agents, "blind-x")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(content, "domains/devops/x-2026-10-15/index.html"), "x");
  writeFileSync(join(content, "experiments/2026-08-16-a/index.html"), "e");
  writeFileSync(join(content, "index.html"), "home");
  writeFileSync(join(agents, "README.md"), "r");
  writeFileSync(join(dir, "wiki.json"), JSON.stringify({ contentRoot: content, mounts: { agents } }));
  const wiki = readWiki(join(dir, "wiki.json"));
  assert.deepEqual(wiki.agentFolders.sort(), ["blind-x", "seo"]);
  assert.deepEqual(wiki.pages.map(page => page.path).sort(), ["domains/devops/x-2026-10-15/index.html", "index.html"]);
});


test("fable auditor's misses: an ongoing ask after the brief no duty names, a stale pause, a met run on n = 0, and a miss no job took up in a day", () => {
  const ask = (ref: string, text: string, ids: string[] = []): Ask => ({ ref, ids, at: NOW - HOUR, text });
  const api = { duty: { id: "d1", name: "Portal stays up", status: "active", ownerWords: "keep watching (#dev-api-portal p25, msg mwwk8mcw)", goal: "Every endpoint answers." }, paused: false, runs: [{ verdict: "met", at: NOW - HOUR }] } satisfies DutyRow;
  // 1. Held by its msg id, by its "#room pN" ref or by a quote; the ask nobody names is unheld.
  assert.equal(askHeld(ask("#dev-api-portal p25", "look, your duty is to keep watching and monitoring this.", ["mwwk8mcw"]), [api]), true);
  assert.equal(askHeld(ask("#dev-api-portal p25", "something else entirely here"), [api]), true);
  assert.equal(askHeld(ask("dm_api-portal p9", "Every endpoint answers. keep it so"), [api]), false);
  assert.equal(askHeld(ask("dm_api-portal p9", "every endpoint answers. keep it like that every day"), [{ ...api, duty: { ...api.duty, goal: "Every endpoint answers. Keep it like that every day, he said." } }]), true);
  // 2. A pause with a condition is stale after a day, one without after 7 days.
  assert.equal(stalePause({ since: NOW - 25 * HOUR, reason: "d6 is paused until the paid proxy is back." }, NOW), true);
  assert.equal(stalePause({ since: NOW - 25 * HOUR, reason: "d6 is paused." }, NOW), false);
  assert.equal(stalePause({ since: NOW - 8 * 24 * HOUR }, NOW), true);
  const paused = { duty: { id: "d6", name: "Meta Ads crawl", status: "paused" }, paused: true, runs: [] } satisfies DutyRow;
  assert.equal(pauseReason(paused, { plan: [{ text: "Crawl", children: [{ text: "Hold lanes", note: "Done. d6 stays paused until the paid proxy is back. Next." }] }] }), "d6 stays paused until the paid proxy is back.");
  // 3. n from a detail file: a number, or the largest of a per-metric object, so a metric with no input is covered by one that measured
  // something; all zero is 0, and none is null.
  assert.equal(sampleSize({ n: 0 }), 0);
  assert.equal(sampleSize({ n: { success_pct: 0, quiet_day_checks_failing: 3 } }), 3, "mcp's quiet-day check covers a day with no customer call");
  assert.equal(sampleSize({ n: { agents: 18, posts: 0, jobs: 4, duties: 60, steps: 90 } }), 90, "fable auditor's sweep in a quiet 3 h with no owner post");
  assert.equal(sampleSize({ n: { success_pct: 0, p95_ms: 0 } }), 0);
  assert.equal(sampleSize({ metrics: {} }), null);
  const out = agentPattern([
    {
      agent: { id: "ag_mcp", name: "mcp", thread: "t-mcp" }, brief: "MCP",
      duties: [{ duty: { id: "d1", name: "Prod MCP", status: "active" }, paused: false, runs: [{ verdict: "met", at: NOW - HOUR }] },
        { duty: { id: "d2", name: "Insight refusals", status: "active" }, paused: false, runs: [{ verdict: "met", at: NOW - HOUR }] }],
      samples: { d1: 0, d2: null }, asks: [ask("dm_mcp p4", "watch the insight endpoint every day", ["mwaaaaaa"])],
    },
    { agent: { id: "ag_crawler-guy", name: "Crawler guy", thread: "t-c" }, brief: "Crawler", duties: [paused, duty("d1", "Read cost", ["met"])], pauses: { d6: { since: NOW - 45 * HOUR, reason: "d6 stays paused until the paid proxy is back." } } },
  ], [], NOW, { standing: [{ ref: "dm_mcp p4", agent: "ag_mcp" }], one_time: [] });
  assert.deepEqual([out.metrics.asks_unheld, out.metrics.pauses_stale, out.metrics.met_on_zero, out.metrics.runs_without_n], [1, 1, 1, 1]);
  assert.deepEqual(out.flagged.filter(flag => ["ask_unheld", "pause_stale", "met_on_zero", "no_sample_size"].includes(flag.kind)).map(flag => flag.sig),
    ["ag_mcp/ask/dm_mcp p4", "ag_mcp/d1/n0", "ag_mcp/d2/n", "ag_crawler-guy/d6/pause"]);
  assert.match(out.messages.find(message => message.agent === "ag_mcp")!.text, /ongoing ask dm_mcp p4 \(msg mwaaaaaa\)/);
  // A run on n = 0 whose detail flags an outside_wait named a wait on the owner, so it is not met_on_zero: VP of GTM's d1 on 11-26.
  const gtm = agentPattern([{
    agent: { id: "ag_vp-of-gtm", name: "VP of GTM", thread: "t-gtm" }, brief: "GTM",
    duties: [{ duty: { id: "d1", name: "Outreach campaigns", status: "active" }, paused: false, runs: [{ verdict: "met", at: NOW - HOUR }] }],
    samples: { d1: 0 }, waitsOutside: ["d1"],
  }], [], NOW);
  assert.equal(gtm.metrics.met_on_zero, 0);
  assert.deepEqual(gtm.flagged.filter(flag => flag.kind === "met_on_zero"), []);
  // 4. A miss first flagged over a day ago and still flagged, with no job of the agent at work since, is unfixed; one a job took up is not.
  const old = [{ at: NOW - 30 * HOUR, flagged: [
    { kind: "common_missing", sig: "ag_mcp/review", item: "ag_mcp", excerpt: "" },
    { kind: "common_missing", sig: "ag_seo/review", item: "ag_seo", excerpt: "" },
    { kind: "dated_page", sig: "domains/x-2026-10-15.html", item: "domains/x-2026-10-15.html", excerpt: "" },
  ] }, { at: NOW - 2 * HOUR, flagged: [{ kind: "common_missing", sig: "ag_vent/review", item: "ag_vent", excerpt: "" }] }];
  const now = [
    { kind: "common_missing", sig: "ag_mcp/review", item: "ag_mcp", excerpt: "" }, { kind: "common_missing", sig: "ag_seo/review", item: "ag_seo", excerpt: "" },
    { kind: "common_missing", sig: "ag_vent/review", item: "ag_vent", excerpt: "" },
  ];
  assert.deepEqual(unfixedMisses(old, now, new Map([["ag_seo", [NOW - 3 * HOUR]], ["ag_mcp", [NOW - 40 * HOUR]]]), NOW).map(flag => flag.sig), ["ag_mcp/review"]);
});

test("ongoingAsk needs the verb form, so a noun or a one-off keep reads no ask", () => {
  for (const text of ["look, your duty is to keep watching and monitoring this.", "daily로 사람들이 어떻게 product를 쓰고 있는지 분석해서 알려줘", "make sure nothing is outside komodo (and should always be like that)",
    "monitor the MCP latency", "그 metal-01 local도 추가해야되지 않을까? 계속 확인하려면?", "how much ppl use/signup/visit .. for api portal every day?"]) assert.equal(ongoingAsk(text), true, text);
  for (const text of ["good keep it this way there was no issues whatsoever right?", "cosmetics monitor 가 200$/m 인데", "brand watching is cheap 확실해?", "add a keep unread feature"]) {
    assert.equal(ongoingAsk(text), false, text);
  }
});

test("ongoingAsk reads a time word that only names a duty or the review as no ask, unless the post approves the duty or asks to set one up", () => {
  // #sw-factory-build p250 (msg mx09gu0o), a design question that made d7 flag ask_unheld on 11-28; p245 beside it approved a weekly duty.
  const p250 = "what’s the the principle, motivation, actual logic that applies to them, and thus practical ideal shape for daily duties? \n- is it best to list it all like this? \n"
    + "- present a role model example (and i’ll comment on it). \n- compare the current duty code, duty-making related skill instructions compared to the prime-agent chat era to see if they are 100% identical or where it differs (personally i like how it behaved previously)";
  for (const text of [p250, "is it configured as a daily duty?", "weekly duty", "why does the daily review take 20 min?", "why did you make 9 daily duties?"]) assert.equal(ongoingAsk(text), false, text);
  for (const text of ["yeah weekly duty sound good.", "check this daily", "make this a daily duty", "set up a weekly duty for the cost report", "do a daily review of the costs"]) {
    assert.equal(ongoingAsk(text), true, text);
  }
});

test("asksTo reads the owner's ongoing asks after the brief: DM posts, and group posts that tag the agent or reach it untagged", () => {
  const store = {
    rooms: { rooms: [
      { id: "dm_mcp", kind: "dm", agent: "ag_mcp", archived: false },
      { id: "ch_1", kind: "channel", name: "dev-mcp", archived: false, members: [{ agent: "ag_mcp", wakeOn: "all" }, { agent: "ag_seo", wakeOn: "all" }] },
      { id: "ch_2", kind: "channel", name: "test-room", archived: false, test: true, members: [{ agent: "ag_mcp", wakeOn: "all" }] },
    ] },
    postsOf: (room: string) => ({
      dm_mcp: [
        { id: "p1", author: "owner", text: "keep the endpoint up every day", at: NOW - 10 * HOUR, inputs: [{ at: NOW - 10 * HOUR + 5 }] },
        { id: "p2", author: "owner", text: "keep the endpoint up every day", at: NOW - 30 * HOUR },
        { id: "p3", author: "owner", text: "fix the button", at: NOW - HOUR },
        { id: "p4", author: "ag_mcp", text: "I keep watching", at: NOW - HOUR },
      ],
      ch_1: [
        { id: "p7", author: "owner", text: "@seo monitor the clicks daily", at: NOW - HOUR, mentions: ["ag_seo"] },
        { id: "p8", author: "owner", text: "monitor the MCP latency", at: NOW - HOUR },
      ],
      ch_2: [{ id: "p1", author: "owner", text: "watch this daily", at: NOW - HOUR }],
    } as Record<string, unknown[]>)[room] ?? [],
  };
  const asks = asksTo(store, { id: "ag_mcp", name: "mcp" }, NOW - 24 * HOUR);
  assert.deepEqual(asks.map(item => item.ref), ["dm_mcp p1", "#dev-mcp p8"]);
  assert.deepEqual(asks[0]!.ids, [(NOW - 10 * HOUR + 5).toString(36)]);
});


test("no brief, no area and no owner ask is no area whatever duties another job gave it; a missing n does not put an agent off the pattern", () => {
  const push = { everyMs: 180 * 60_000, planEveryMs: 180 * 60_000, paused: false, lastAt: NOW - HOUR, runs: [{ at: NOW - HOUR }] };
  const review: DutyRow = {
    duty: { id: "d1", name: "Area review", status: "active" }, paused: false, schedule: { kind: "daily", at: "05:40" }, nextAt: NOW + 20 * HOUR,
    runs: [{ verdict: "met", at: NOW - HOUR, metrics: { corrections_unsaved: { value: 0 } }, job: { id: "j" } }],
  };
  const out = agentPattern([
    { agent: { id: "ag_feature-probe", name: "feature probe" }, duties: [review], checkIn: push },
    // A review run after release-11e4c28, so its missing n counts (AREA_REVIEW_N_SINCE).
    { agent: { id: "ag_seo", name: "seo" }, brief: "SEO", duties: [{ ...review, runs: [{ ...review.runs[0]!, at: AREA_REVIEW_N_SINCE + HOUR }] }], checkIn: push, outputs: { d1: true }, samples: { d1: null } },
  ], [], NOW);
  assert.deepEqual(out.flagged.filter(flag => flag.item === "ag_feature-probe").map(flag => flag.kind), ["no_area"]);
  assert.equal(out.metrics.agents_without_area, 1);
  assert.equal(out.metrics.runs_without_n, 1);
  assert.equal(out.metrics.agents_off_pattern, 0);
  // seo still gets a nudge to add n, though it is on the pattern.
  assert.deepEqual(out.messages.map(message => message.agent), ["ag_seo"]);
});

test("d7 counts more than one job for the same duty and hand-off sig as duplicate jobs, and nudges nobody for it", () => {
  const sigs = (at: number, ...list: string[]) => ({ at, sigs: list });
  assert.deepEqual(duplicateJobs([sigs(NOW, "ag_vp-of-gtm:2026-11-25"), sigs(NOW + 600_000, "ag_vp-of-gtm:2026-11-25"), sigs(NOW + 700_000), sigs(NOW + 900_000, "ag_vp-of-gtm:2026-11-25"),
    sigs(NOW, "ag_vp-of-gtm:2026-11-24")], NOW + HOUR), [["ag_vp-of-gtm:2026-11-25", 3]]);
  // The same page sig handed once a day for three days is no duplicate.
  assert.deepEqual(duplicateJobs([sigs(NOW, "off_shape:20"), sigs(NOW + 25 * HOUR, "off_shape:20"), sigs(NOW + 50 * HOUR, "off_shape:20")], NOW + 50 * HOUR), []);
  // Verify and busy runs that name the job still at work are one job, not three (179 read against 57 real repeats on 11-26).
  const ran = (at: number, job: string, sig: string) => ({ at, job, sigs: [sig] });
  assert.deepEqual(duplicateJobs([ran(NOW, "j1", "a"), ran(NOW + HOUR, "j1", "a"), ran(NOW + 2 * HOUR, "j1", "a")], NOW + 2 * HOUR), []);
  assert.deepEqual(duplicateJobs([ran(NOW, "j1", "a"), ran(NOW + HOUR, "j1", "a"), ran(NOW + 2 * HOUR, "j2", "a")], NOW + 2 * HOUR), [["a", 2]]);
  // A repeat more than a day before now is history the runner fix already ended (63 such read on 11-26); a fresh one still counts.
  assert.deepEqual(duplicateJobs([ran(NOW - 30 * HOUR, "j1", "old"), ran(NOW - 29 * HOUR, "j2", "old"), ran(NOW - 3 * HOUR, "j3", "new"), ran(NOW - 2 * HOUR, "j4", "new")], NOW),
    [["new", 2]]);
  const out = agentPattern([{
    agent: { id: "ag_vp-of-gtm", name: "VP of GTM" }, brief: "GTM", duties: [duty("d3", "Area review", ["met"])],
    handOffJobs: { d3: [sigs(NOW - HOUR, "ag_vp-of-gtm:2026-11-25"), sigs(NOW - 2 * HOUR, "ag_vp-of-gtm:2026-11-25")] },
  }], [], NOW);
  assert.equal(out.metrics.duplicate_jobs, 1);
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "duplicate_job").map(flag => flag.excerpt), ['VP of GTM: d3 "Area review" started 1 extra jobs for 1 hand-off within a day, such as 2 jobs for ag_vp-of-gtm:2026-11-25']);
  assert.equal(out.metrics.agents_off_pattern, 0);
});

test("an ask another agent's live duty quotes is held, and its item names that agent and duty", () => {
  const ask: Ask = { ref: "#api-portal-outreach p1", ids: ["mwwfkgw4"], at: NOW - HOUR, text: "how much ppl use/signup/visit .. for api portal every day?" };
  const usage: DutyRow = {
    duty: { id: "d3", name: "API portal usage", status: "active", ownerWords: "how much ppl use/signup/visit .. for api portal every day? (#api-portal-outreach p1, msg mwwfkgw4)" },
    paused: false, runs: [{ verdict: "met", at: NOW - HOUR }],
  };
  const out = agentPattern([
    { agent: { id: "ag_vp-of-gtm", name: "VP of GTM" }, brief: "GTM", duties: [duty("d1", "Outreach campaigns", ["met"])], asks: [ask] },
    { agent: { id: "ag_product-analytics-bot", name: "product analytics bot" }, brief: "Analytics", duties: [usage] },
  ], [], NOW);
  assert.equal(out.metrics.asks_unheld, 0);
  assert.deepEqual(out.flagged.filter(flag => flag.kind.startsWith("ask_")).map(flag => flag.excerpt),
    ['VP of GTM: the owner\'s ongoing ask #api-portal-outreach p1 is held by product analytics bot\'s d3 "API portal usage"']);
  // A paused holder holds nothing.
  const paused = agentPattern([
    { agent: { id: "ag_vp-of-gtm", name: "VP of GTM" }, brief: "GTM", duties: [duty("d1", "Outreach campaigns", ["met"])], asks: [ask] },
    { agent: { id: "ag_product-analytics-bot", name: "product analytics bot" }, brief: "Analytics", duties: [{ ...usage, paused: true }] },
  ], [], NOW, { standing: [{ ref: "#api-portal-outreach p1", agent: "VP of GTM" }], one_time: [] });
  assert.equal(paused.metrics.asks_unheld, 1);
});

test("a post the ongoing words match is a candidate: unsorted it is handed to the duty job and puts no agent off the pattern, one_time drops it, standing counts it once for its agent", () => {
  // #1124-cost-management p33 (msg mx0amn69, 11-28): a one-time chart change that d7 counted as an unheld ask of the room's three members.
  const p33: Ask = { ref: "#1124-cost-management p33", ids: ["mx0amn3k", "mx0amn69"], at: NOW - HOUR, text: "+properly organize this chart to be daily. same for other charts. make this the primiary chart" };
  const member = (id: string, name: string) => ({ agent: { id, name, thread: `t-${id}` }, brief: name, duties: [duty("d1", "Its own duty", ["met"])], asks: [p33] });
  const members = [member("ag_fable-auditor", "fable auditor"), member("ag_search-product-misc", "Search product, misc."), member("ag_vent", "vent")];
  const asks = (out: ReturnType<typeof agentPattern>) => out.flagged.filter(flag => flag.kind.startsWith("ask_"));

  const unsorted = agentPattern(members, [], NOW);
  assert.deepEqual([unsorted.metrics.agents_off_pattern, unsorted.metrics.asks_unheld, unsorted.metrics.asks_unsorted], [0, 0, 1]);
  assert.deepEqual(asks(unsorted).map(flag => [flag.kind, flag.sig, flag.handOff, flag.item]), [["ask_unsorted", "ask-unsorted/#1124-cost-management p33", true, undefined]]);
  assert.match(asks(unsorted)[0]!.excerpt, /#1124-cost-management p33 \(msg mx0amn69\).*reached fable auditor, Search product, misc\., vent: "\+properly organize this chart to be daily\..*primiary chart"/);
  assert.deepEqual(unsorted.messages, [], "an unsorted candidate nudges nobody");

  const oneTime = agentPattern(members, [], NOW, { standing: [], one_time: [{ ref: "#1124-cost-management p33", why: "a one-time chart change" }] });
  assert.deepEqual(asks(oneTime), []);
  assert.deepEqual([oneTime.metrics.agents_off_pattern, oneTime.metrics.asks_unheld, oneTime.metrics.asks_unsorted], [0, 0, 0]);

  // The ask is for devops guy, who is no member of the room: `asksTo` reads the post for it from the standing entry.
  const devops = { agent: { id: "ag_devops-guy", name: "devops guy", thread: "t-devops" }, brief: "Devops", duties: [duty("d1", "Nothing outside Komodo", ["met"])], asks: [p33] };
  const standing = agentPattern([...members, devops], [], NOW, { standing: [{ ref: "#1124-cost-management p33", agent: "ag_devops-guy", why: "he wants the cost charts kept daily" }], one_time: [] });
  assert.deepEqual(asks(standing).map(flag => [flag.kind, flag.sig]), [["ask_unheld", "ag_devops-guy/ask/#1124-cost-management p33"]]);
  assert.deepEqual([standing.metrics.agents_off_pattern, standing.metrics.asks_unheld, standing.metrics.asks_unsorted], [1, 1, 0]);
  assert.deepEqual(standing.messages.map(message => message.agent), ["ag_devops-guy"]);
  // An entry matches by a message id too, so a renamed room keeps its sorted posts; the agent may be given by name.
  const byMsg = agentPattern([...members, devops], [], NOW, { standing: [{ ref: "#cost p33", msg: "mx0amn69", agent: "devops guy" }], one_time: [] });
  assert.deepEqual(asks(byMsg).map(flag => flag.sig), ["ag_devops-guy/ask/#1124-cost-management p33"]);
  // A standing ask a duty of its agent names is held and flags nothing.
  const held = agentPattern([...members, { ...devops, duties: [{ duty: { id: "d2", name: "Cost charts stay daily", status: "active", ownerWords: "(#1124-cost-management p33)" }, paused: false, runs: [{ verdict: "met" }] }] }], [], NOW,
    { standing: [{ ref: "#1124-cost-management p33", agent: "ag_devops-guy" }], one_time: [] });
  assert.deepEqual(asks(held), []);
});

test("an unsorted candidate gives an agent with no brief no area, is still handed off, and a duty of the agent that names it makes it standing", () => {
  const ask: Ask = { ref: "dm_feature-probe p2", ids: [], at: NOW - HOUR, text: "make this chart daily" };
  const probe = { agent: { id: "ag_feature-probe", name: "feature probe" }, duties: [duty("d1", "Its own duty", ["met"])], asks: [ask] };
  const out = agentPattern([probe], [], NOW);
  assert.deepEqual(out.flagged.map(flag => flag.kind), ["no_area", "ask_unsorted"]);
  assert.equal(out.metrics.agents_off_pattern, 0);
  const quoted = agentPattern([{ ...probe, duties: [{ duty: { id: "d1", name: "Chart", status: "active", goal: "dm_feature-probe p2" }, paused: false, runs: [{ verdict: "met" }] }] }], [], NOW);
  assert.deepEqual(quoted.flagged.filter(flag => flag.kind === "no_area" || flag.kind.startsWith("ask_")), []);
});

test("the sorted-asks file is optional, and a file of another shape throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "asks-"));
  assert.deepEqual(readAsks(join(dir, "none.json")), { standing: [], one_time: [] });
  const file = join(dir, "asks.json");
  writeFileSync(file, JSON.stringify({ standing: [{ ref: "#dev-api-portal p25", msg: "mwwk8mcw", agent: "ag_api-portal", why: "keep watching" }], one_time: [{ ref: "#sw-factory-build p250", why: "a design question" }] }));
  assert.equal(readAsks(file).standing[0]!.agent, "ag_api-portal");
  for (const bad of [{ standing: [{ ref: "#x p1" }], one_time: [] }, { standing: [] }, { standing: [], one_time: ["#x p1"] }, []]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => readAsks(file), /is not \{standing/);
  }
});

test("asksTo reads a post a standing entry gives the agent from any real room, whatever its words, tags and members", () => {
  const store = {
    rooms: { rooms: [
      { id: "ch_1", kind: "channel", name: "1124-cost-management", archived: false, members: [{ agent: "ag_vent", wakeOn: "all" }] },
      { id: "ch_2", kind: "channel", name: "test-room", archived: false, test: true, members: [] },
    ] },
    postsOf: (room: string) => ({
      ch_1: [
        { id: "p33", author: "owner", text: "@vent keep the cost chart current", at: NOW - HOUR, mentions: ["ag_vent"], inputs: [{ at: NOW - HOUR + 5 }] },
        { id: "p34", author: "owner", text: "check this daily", at: NOW - HOUR },
        { id: "p35", author: "owner", text: "an old one", at: NOW - 30 * HOUR },
      ],
      ch_2: [{ id: "p1", author: "owner", text: "watch this daily", at: NOW - HOUR }],
    } as Record<string, unknown[]>)[room] ?? [],
  };
  const devops = { id: "ag_devops-guy", name: "devops guy" };
  assert.deepEqual(asksTo(store, devops, NOW - 24 * HOUR), [], "no member, and no post given to it");
  const given = [{ ref: "#1124-cost-management p33" }, { ref: "#renamed p34", msg: "nomatch" }, { ref: "#1124-cost-management p35" }, { ref: "#test-room p1" }];
  assert.deepEqual(asksTo(store, devops, NOW - 24 * HOUR, given).map(item => item.ref), ["#1124-cost-management p33"], "a post before the brief and a test room stay out");
  assert.deepEqual(asksTo(store, devops, NOW - 24 * HOUR, [{ ref: "#old-name p33", msg: (NOW - HOUR + 5).toString(36) }]).map(item => item.ref), ["#1124-cost-management p33"]);
});

test("a check-in is not late right after the plan gets its first open step: the shorter interval counts from then", () => {
  // fable auditor at 19:55 KST 11-28: daily check-ins on an empty plan, a step opened 13 h after the last one, and d7 read it 18 s later.
  const iso = (at: number) => new Date(at).toISOString();
  assert.equal(planOpenSince({ plan: [{ status: "done", updatedAt: iso(NOW - 40 * HOUR), children: [{ status: "done" }] }] }), null);
  assert.equal(planOpenSince({ plan: [{ status: "done", children: [{ status: "doing", updatedAt: iso(NOW - 18_000) }] }] }), NOW - 18_000);
  assert.equal(planOpenSince({ plan: [{ status: "todo", updatedAt: iso(NOW - 18_000) }, { status: "blocked", updatedAt: iso(NOW - 30 * HOUR) }] }), NOW - 30 * HOUR, "the oldest open step");
  assert.equal(planOpenSince({ plan: [{ status: "todo", updatedAt: iso(NOW - 18_000) }, { status: "todo" }] }), 0, "an open step with no time has been open for as long as anyone knows");
  const review: DutyRow = {
    duty: { id: "d1", name: "Area review", status: "active" }, paused: false, schedule: { kind: "daily", at: "05:40" }, nextAt: NOW + 20 * HOUR,
    runs: [{ verdict: "met", at: NOW - HOUR, metrics: { corrections_unsaved: { value: 0 } }, job: { id: "j" } }],
  };
  const fable = (planOpenAt: number | null) => ({
    agent: { id: "ag_fable-auditor", name: "fable auditor" }, brief: "Audit", duties: [review], planOpenAt,
    checkIn: { everyMs: 180 * 60_000, paused: false, lastAt: NOW - 13 * HOUR, runs: [{ at: NOW - 13 * HOUR }] },
  });
  const late = (planOpenAt: number | null) => agentPattern([fable(planOpenAt)], [], NOW).flagged.filter(flag => flag.kind === "common_late").map(flag => flag.excerpt);
  assert.deepEqual(late(NOW - 18_000), []);
  assert.deepEqual(late(NOW - 5 * HOUR), [], "within 2 intervals of the step opening");
  assert.deepEqual(late(NOW - 7 * HOUR), ["fable auditor: its check-in last ran 13 h ago on a 180 min interval"]);
  assert.deepEqual(late(0).length, 1);
  assert.deepEqual(late(null).length, 1, "a read with no plan time judges by the last run alone");
  // d5 reads the same check-in with 1.5 intervals.
  const board = (planOpenAt: number | null) => agentBoards([{
    agent: { id: "ag_fable-auditor", name: "fable auditor" }, steps: { open: 1, stuck: [], gaps: [] }, planOpenAt,
    checkIn: { everyMs: 3 * HOUR, paused: false, lastAt: NOW - 13 * HOUR, runs: [{ at: NOW - 13 * HOUR, verdict: "met", summary: "" }] },
  }], NOW).metrics.checkins_late;
  assert.deepEqual([board(NOW - 18_000), board(NOW - 5 * HOUR), board(null)], [0, 1, 1]);
});

test("a missing n on an Area review run from before release-11e4c28 is not flagged; a later one and any other duty's newest run are", () => {
  const review = (at: number): DutyRow => ({ duty: { id: "d2", name: "Area review", status: "active" }, paused: false, runs: [{ verdict: "met", at, metrics: { corrections_unsaved: { value: 0 } } }] });
  const other: DutyRow = { duty: { id: "d1", name: "Prod MCP", status: "active" }, paused: false, runs: [{ verdict: "met", at: AREA_REVIEW_N_SINCE - HOUR }] };
  const out = agentPattern([
    { agent: { id: "ag_mcp", name: "mcp" }, brief: "MCP", duties: [review(AREA_REVIEW_N_SINCE - HOUR), other], samples: { d2: null, d1: null } },
    { agent: { id: "ag_seo", name: "seo" }, brief: "SEO", duties: [review(AREA_REVIEW_N_SINCE + HOUR)], samples: { d2: null } },
  ], [], AREA_REVIEW_N_SINCE + 2 * HOUR);
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "no_sample_size").map(flag => flag.sig), ["ag_mcp/d1/n", "ag_seo/d2/n"]);
  assert.equal(out.metrics.runs_without_n, 2);
});

// The three readings of the owner's #1124-cost-management p60 (msg mx0bgshc, 11-28), in scripts/duties/duty-health.ts.
// An apps/chat file as this run loads it: a spec-clean run (scripts/spec-clean.mjs) names the files it takes from the checkout in SPEC_CLEAN_OVERLAY.
const appFile = (path: string): string => readFileSync((JSON.parse(process.env.SPEC_CLEAN_OVERLAY ?? "{}") as Record<string, string>)[path] ?? join(import.meta.dirname, "../..", path), "utf8");
const D7 = JSON.parse(appFile("scripts/duties/agent-duties.duty.json")) as { metrics: DutyMetric[]; readings: { key: string }[]; ownerWords: string };
const past = (id: string, command: string | null): PastProblem => ({ id, agent: "ag_devops-guy", duty: "d17", what: "A PostHog sync cost up to $80 a day and the bill check named no PostHog line", when: "2026-11-15", source: "#1124-cost-management p56 (msg mx0b5pkg)", replay: command });

test("a past problem whose replay exits 1 is a check that would still miss it, and a replay runs without the run's own OUTPUT_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  assert.deepEqual(await replay("exit 0", dir), { result: "flagged" });
  assert.deepEqual(await replay("exit 1", dir), { result: "missed" });
  assert.equal((await replay("echo broken >&2; exit 3", dir)).result, "not_measured", "another exit proves neither");
  assert.match((await replay("exit 3", dir) as { why: string }).why, /exit 3/);
  assert.match((await replay("sleep 5", dir, 200) as { why: string }).why, /did not end in 0 s/);
  // d7's own run sets OUTPUT_FILE; a replayed precheck that inherited it would write its output over d7's.
  process.env.OUTPUT_FILE = join(dir, "d7.json");
  try { assert.deepEqual(await replay('test -z "$OUTPUT_FILE" && test "$(pwd -P)" = "$(cd "$PWD" && pwd -P)"', dir), { result: "flagged" }); } finally { delete process.env.OUTPUT_FILE; }
  const out = blindChecks([
    { ...past("posthog-sync", "exit 1"), replayed: await replay("exit 1", dir) },
    { ...past("first-reply-gap", "exit 0"), agent: "agent factory", duty: "d1", replayed: await replay("exit 0", dir) },
  ], [{ id: "ag_devops-guy", name: "devops guy" }, { id: "ag_agent-factory", name: "agent factory" }]);
  assert.deepEqual(out.metrics, { checks_blind: 1, past_problems: 2, past_problems_not_measured: 0 });
  assert.equal(out.n, 2, "n is the past problems a replay answered");
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.sig, flag.handOff, flag.item]), [["check_blind", "past/posthog-sync", true, undefined]], "the duty job gets it, and no agent goes off the pattern");
  assert.match(out.flagged[0]!.excerpt, /devops guy d17, 2026-11-15: A PostHog sync cost .* \(#1124-cost-management p56 \(msg mx0b5pkg\)\)\. Replay: exit 1/);
});

test("a past problem with replay null reads not measured, never met", async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const unmeasured = { ...past("posthog-sync", null), replayed: await replay(null, dir) };
  assert.deepEqual(unmeasured.replayed, { result: "not_measured", why: "it has no replay command yet" });
  const caught = { ...past("first-reply-gap", "exit 0"), replayed: { result: "flagged" } as const };
  const out = blindChecks([unmeasured, caught], [{ id: "ag_devops-guy", name: "devops guy" }]);
  assert.deepEqual(out.metrics, { past_problems: 2, past_problems_not_measured: 1 }, "checks_blind has no value");
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.sig, flag.handOff]), [["gap", "past/posthog-sync/replay", true]]);
  // The duty's own judge reads the run as error and names the metric and the reason, whatever the other three metrics read.
  const judged = judge(D7.metrics, { metrics: { agents_off_pattern: 0, problems_returned: 0, duty_system_faults: 0, ...out.metrics }, flagged: out.flagged });
  assert.equal(judged.verdict, "error");
  assert.match(judged.summary, /not measured: the precheck gave no value for checks_blind \(past problem posthog-sync is not measured, because it has no replay command yet/);
  assert.equal(judged.metrics.checks_blind, undefined);
  // A miss among the others is known whatever the unmeasured one would read, so the count keeps its value and the run reads missed.
  const missed = blindChecks([unmeasured, { ...past("vp-gtm", "exit 1"), replayed: { result: "missed" } as const }], []);
  assert.equal(missed.metrics.checks_blind, 1);
  assert.equal(judge(D7.metrics, { metrics: { agents_off_pattern: 0, problems_returned: 0, duty_system_faults: 0, ...missed.metrics } }).verdict, "missed");
  // With every past problem replayed and flagged the count is 0 and the run reads met.
  const met = blindChecks([caught], []);
  assert.equal(judge(D7.metrics, { metrics: { agents_off_pattern: 0, problems_returned: 0, duty_system_faults: 0, ...met.metrics } }).verdict, "met");
});

test("the past-problems and sorted-returns files read as lists or throw on another shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "past-"));
  const write = (name: string, value: unknown) => { writeFileSync(join(dir, name), JSON.stringify(value)); return join(dir, name); };
  assert.deepEqual(readPastProblems(join(dir, "none.json")), []);
  assert.deepEqual(readPastProblems(write("ok.json", [past("a", null), past("b", "exit 0")])).map(entry => entry.replay), [null, "exit 0"]);
  assert.throws(() => readPastProblems(write("no-replay.json", [{ ...past("a", null), replay: undefined }])), /replay is a command or null/);
  assert.throws(() => readPastProblems(write("twice.json", [past("a", null), past("a", null)])), /one entry per id/);
  assert.throws(() => readPastProblems(write("object.json", { a: past("a", null) })), /is not a list/);
  assert.deepEqual(readReturns(join(dir, "none.json")), { lasting: [], new_work: [] });
  assert.throws(() => readReturns(write("bad.json", { lasting: [{ agent: "seo", duty: "d1", metric: "m", why: "no time" }], new_work: [] })), /is not \{lasting/);
});

test("a metric that went red again twice after a closed fix is a returning problem; one that never left, a settled one and new work are not", () => {
  const read = (hoursAgo: number, met: boolean) => ({ at: NOW - hoursAgo * HOUR, met });
  const close = (step: string, hoursAgo: number) => ({ step, at: NOW - hoursAgo * HOUR, text: `Bring agents back onto their ideal memory (${step})` });
  // agent factory's d3 from 11-26 to 11-28: red, fix closed, green on the verify run, red at the next 07:31 run, twice.
  const flapping = { reads: [read(72, false), read(70, true), read(48, false), read(46, true), read(24, false)], closes: [close("p330", 71), close("p349", 47)] };
  assert.deepEqual(returnsOf(flapping.reads, flapping.closes, NOW), [NOW - 48 * HOUR, NOW - 24 * HOUR]);
  // agent factory's d2 never met once in a week while 26 fix steps closed: it never came back, because it never left.
  const stuck = { reads: [read(72, false), read(48, false), read(24, false)], closes: [close("p1", 60), close("p2", 40), close("p3", 30)] };
  assert.deepEqual(returnsOf(stuck.reads, stuck.closes, NOW), []);
  assert.deepEqual(returnsOf(flapping.reads, [], NOW), [], "a red again with no closed fix before it is a new miss, not a return");
  assert.deepEqual(returnsOf(flapping.reads, [close("old", 15 * 24 + 48)], NOW), [], "the fix closed over 14 days before the miss");
  assert.deepEqual(returnsOf([read(20 * 24, true), read(19 * 24, false)], [close("p1", 21 * 24)], NOW), [], "a return over 14 days ago has left the window");
  const history = (agent: string, duty: string, metric: string, data: typeof flapping) => ({ agent: { id: `ag_${agent}`, name: agent }, duty: { id: duty, name: "Agent memory" }, metric, ...data });
  const histories = [
    history("agent-factory", "d3", "agents_on_ideal_pct", flapping), history("agent-factory", "d2", "slowest_api_p90_ms", stuck),
    history("fable-auditor", "d1", "findings_unposted", flapping), history("seo", "d1", "visits", flapping),
    history("mcp", "d1", "calls", { reads: [read(48, true), read(24, false)], closes: [close("p9", 30)] }),
  ];
  const out = returningProblems(histories, {
    lasting: [{ agent: "seo", duty: "d1", metric: "visits", at: new Date(NOW - 30 * HOUR).toISOString(), why: "the sitemap job now runs before the check" }],
    new_work: [{ agent: "ag_fable-auditor", duty: "d1", metric: "findings_unposted", why: "each sweep finds new items to judge" }],
  }, NOW);
  assert.deepEqual(out.metrics, { problems_returned: 1, returns_new_work: 1 });
  assert.equal(out.n, 5, "n is the metrics with a closed fix step");
  assert.deepEqual(out.flagged.map(flag => [flag.kind, flag.sig, flag.handOff, flag.item]), [["problem_returned", "returned/ag_agent-factory/d3/agents_on_ideal_pct", true, undefined]]);
  assert.match(out.flagged[0]!.excerpt, /agents_on_ideal_pct went red again 2 times in 14 days after a closed fix, at 11-22 09:00, 11-23 09:00 KST\. Closed fix steps: p330 \(11-21 10:00, "Bring agents back onto their ideal memory \(p330\)"\); p349 \(11-22 10:00/);
  assert.equal(returningProblems(histories, undefined, NOW).metrics.problems_returned, 3, "with no sorted file each of the three counts");
  // The inputs: a closed fix step needs its duty link, done and a time; a run file's stamp is KST; a placeholder is no reading.
  assert.deepEqual(fixCloses([
    { id: "p1", status: "done", duty: "d3/agents_on_ideal_pct", updatedAt: "2026-11-23T00:00:00Z", text: "Fix" }, { id: "p2", status: "done", duty: "d3/agents_on_ideal_pct" },
    { id: "p3", status: "doing", duty: "d3/agents_on_ideal_pct", updatedAt: "2026-11-23T00:00:00Z" }, { id: "p4", status: "done", duty: "d3/recall_right_pct", updatedAt: "2026-11-23T00:00:00Z" },
  ], "d3", "agents_on_ideal_pct"), [{ step: "p1", at: Date.parse("2026-11-23T00:00:00Z"), text: "Fix" }]);
  assert.deepEqual(runFile("d17-261128-151759.json"), { duty: "d17", at: Date.parse("2026-11-28T06:17:59Z") });
  assert.equal(runFile("d8-manual-now.json"), null);
  assert.equal(runFile("d8.after.json"), null);
  assert.deepEqual(readsOf({ metrics: { a: 3, b: 999_999, c: 90 } }, 5, [{ key: "a", op: "<=", target: 0 }, { key: "b", op: "<=", target: 0 }, { key: "c", op: ">=", target: 80 }, { key: "d", op: ">=", target: 1 }]),
    { a: { at: 5, met: false }, c: { at: 5, met: true } });
});

test("a failed precheck, an unmeasured run, a red duty with no job, a lost job report and a duty one job holds are the duty system's faults; waits and readings are not", () => {
  const metrics: DutyMetric[] = [{ key: "lines_over_pace", label: "Lines over pace", op: "<=", target: 0, headline: true }, { key: "reads_failing", label: "Reads failing", op: "<=", target: 0 }];
  // The summaries are the server's own: judge() for an unmeasured metric, duty-run.ts for a failed precheck, boards.ts for an account wait.
  const unmeasured = judge(metrics, { metrics: { lines_over_pace: 0 } });
  assert.match(unmeasured.summary, NOT_MEASURED);
  assert.match(judge(metrics, { metrics: { lines_over_pace: 0, reads_failing: 999_999 } }).summary, NOT_MEASURED);
  assert.doesNotMatch(judge(metrics, { metrics: { lines_over_pace: 0, reads_failing: 0 } }).summary, NOT_MEASURED);
  const server = (file: string) => appFile(`server/${file}`);
  assert.ok(server("duty-run.ts").includes(`summary: "${PRECHECK_FAILED}"`));
  // Four endings for a job with no model answer yet, and the state of one that answered, which each of its three endings carries.
  const waits = [...server("boards.ts").matchAll(/`(?:; )?((?:its job|stopped its job|is waiting)[^`]*model account[^`]*)`/g)].map(match => match[1]!);
  assert.equal(waits.length, 5, "the five wordings besideBusyJob gives a run whose job waits for a model account");
  for (const words of waits) assert.match(words, JOB_WAITS_ACCOUNT);
  const row = (id: string, runs: DutyRow["runs"], more: Partial<DutyRow> = {}): DutyRow => ({ duty: { id, name: `Duty ${id}`, status: "active", metrics }, paused: false, runs, ...more });
  const at = NOW - HOUR;
  // A run that started a job, and a later run beside that job with the words boards.ts gives it and the keys of what it gave the job.
  const HELD = { id: "j-held", name: "Duty duty 261126-061043" };
  const STARTED_NONE = "lines_over_pace 2 (target at most 0); its job Duty duty 261126-061043 still works, so this run started none";
  const WAITS = "lines_over_pace 2 (target at most 0); its job Duty duty 261126-061043 is waiting for a model account since 07:45 KST, so this run started none";
  const started = (when: number, id = HELD.id): DutyRow["runs"][number] => ({ verdict: "missed", at: when, summary: "lines_over_pace 2 (target at most 0)", job: { ...HELD, id, submission: 1, reported: true } });
  const beside = (when: number, summary: string, given?: string[]): DutyRow["runs"][number] => ({ verdict: "missed", at: when, summary, job: HELD, ...(given ? { given } : {}) });
  const out = dutySystemFaults([{
    agent: { id: "ag_devops-guy", name: "devops guy" },
    steps: [
      { id: "p91", status: "done", duty: "d2/unmanaged_dev", updatedAt: new Date(NOW - 2 * HOUR).toISOString(), text: "Stop d2 counting its own precheck unit as unmanaged" },
      { id: "p92", status: "done", duty: "d2/unmanaged_dev", updatedAt: new Date(NOW - 30 * HOUR).toISOString(), text: "Stop d2 counting a removed container" },
      { id: "p93", status: "done", duty: "d2/unmanaged_dev", updatedAt: new Date(NOW - 2 * HOUR).toISOString(), text: "Move the chat backup under Komodo" },
    ],
    leftOut: { d9: "line_left_out: vercel spend: 91.5 USD a cycle" },
    duties: [
      row("d1", [{ verdict: "error", at, summary: PRECHECK_FAILED, error: "exit 1: TypeError: fetch failed" }, { verdict: "error", at: at - HOUR, summary: PRECHECK_FAILED }, { verdict: "error", at: at - 30 * HOUR, summary: PRECHECK_FAILED }]),
      row("d2", [{ verdict: "met", at, summary: "all 2 on target", overrun: { ms: 400_000, targetMs: 120_000 } }]),
      row("d3", [{ verdict: "error", at, summary: unmeasured.summary }]),
      row("d4", [{ verdict: "error", at, summary: unmeasured.summary, hostAway: "mac" }]),
      row("d5", [{ verdict: "error", at, summary: unmeasured.summary, waitsOn: "the owner's buy of the sending setup" }]),
      // The after-job measure read the metric, so the run's own gap is closed.
      row("d6", [{ verdict: "error", at, summary: unmeasured.summary, job: { id: "j6", name: "Duty d6 duty", submission: 1, reported: true }, after: { at, verdict: "met", summary: "all 2 on target" } }]),
      row("d7", [{ verdict: "missed", at, summary: "lines_over_pace 2 (target at most 0)" }]),
      row("d8", [{ verdict: "missed", at, summary: "lines_over_pace 2 (target at most 0)", fixes: { lines_over_pace: { step: "p46", job: "vercel spend cut", live: true } } }]),
      row("d9", [{ verdict: "met", at, summary: "all 2 on target" }]),
      row("d10", [{ verdict: "missed", at, summary: "lines_over_pace 2 (target at most 0); its job Duty d10 duty still waits for a model account and got this run's brief", job: { id: "j10", name: "Duty d10 duty" } },
        { verdict: "missed", at: at - 50 * HOUR, summary: "lines_over_pace 2 (target at most 0)", job: { id: "j10", name: "Duty d10 duty", submission: 1 } }]),
      row("d11", [{ verdict: "missed", at, summary: "lines_over_pace 2 (target at most 0)", job: { id: "j11", name: "Duty d11 duty", submission: 1 }, after: { at, verdict: "missed", summary: "lines_over_pace 2 (target at most 0)" } }]),
      row("d12", [{ verdict: "error", at, summary: PRECHECK_FAILED }], { paused: true }),
      row("d13", [{ verdict: "skipped", at }]),
      { ...row("d14", [{ verdict: "met", at, summary: "all 2 on target" }]), duty: { id: "d14", name: "Duty d14", status: "active", metrics, goal: "Every line stays inside plan. PostHog is left out because its rows carry no price." } },
      // devops guy's d17 from 11-25: one job, and three runs over a day that started none and gave it nothing.
      row("d17", [beside(at, STARTED_NONE), beside(at - 20 * HOUR, STARTED_NONE), beside(at - 24 * HOUR, STARTED_NONE), started(at - 26 * HOUR)]),
      // The same, but each run gave the job its new items, as the duty runner does since 11-28.
      row("d18", [beside(at, STARTED_NONE, ["line_over_pace|posthog//Events"]), beside(at - 20 * HOUR, STARTED_NONE, ["metric|reads_failing"]), beside(at - 24 * HOUR, STARTED_NONE, ["a"]), started(at - 26 * HOUR)]),
      // The job only waited for a model account, which is pi-pool's line.
      row("d19", [beside(at, WAITS), beside(at - 20 * HOUR, WAITS), beside(at - 24 * HOUR, WAITS), started(at - 26 * HOUR)]),
      // A job held three runs and ended; the newest run started another, so nothing holds the duty now.
      row("d20", [started(at, "j-new"), beside(at - 20 * HOUR, STARTED_NONE), beside(at - 24 * HOUR, STARTED_NONE), beside(at - 25 * HOUR, STARTED_NONE), started(at - 26 * HOUR)]),
      // Three such runs inside one day are no streak older than 24 h.
      row("d21", [beside(at, STARTED_NONE), beside(at - HOUR, STARTED_NONE), beside(at - 2 * HOUR, STARTED_NONE), started(at - 3 * HOUR)]),
    ],
  }], NOW);
  assert.deepEqual(out.flagged.filter(flag => flag.handOff).map(flag => flag.sig), [
    "ag_devops-guy/d1/system/precheck_failed", "ag_devops-guy/d2/system/precheck_failed", "ag_devops-guy/d3/system/not_measured", "ag_devops-guy/d7/system/red_no_job", "ag_devops-guy/d11/system/job_unreported",
    "ag_devops-guy/d17/system/held_by_one_job",
  ]);
  assert.ok(out.flagged.every(flag => flag.item === undefined), "the duty job owns them, and no agent goes off the pattern");
  assert.deepEqual(out.metrics, {
    duty_system_faults: 6, prechecks_failed: 2, duties_not_measured: 1, red_duties_no_job: 1, duty_jobs_unreported: 1, duties_held_by_one_job: 1,
    precheck_failed_runs_24h: 3, unmeasured_runs_24h: 1, duty_jobs_waiting_account: 2, fixes_blaming_check_24h: 1, duties_met_leaving_out: 2,
    duties_held_in_streak: 3,
  });
  assert.equal(out.n, 17, "n is the duties that are not paused and have a measured run");
  assert.match(out.flagged.find(flag => flag.kind === "system_held_by_one_job")!.excerpt,
    /devops guy d17 "Duty d17": it is not met since 11-23 06:00 KST, and 3 of its runs started no job and gave its job Duty duty 261126-061043 nothing: lines_over_pace 2/);
  assert.deepEqual(heldJobs([beside(at, WAITS), beside(at - 20 * HOUR, STARTED_NONE), beside(at - 24 * HOUR, STARTED_NONE), started(at - 26 * HOUR)], NOW),
    [{ job: "j-held", name: "Duty duty 261126-061043", runs: 3, waits: 1, since: at - 26 * HOUR, now: true }]);
  const excerpt = (kind: string) => out.flagged.filter(flag => flag.kind === kind).map(flag => flag.excerpt);
  assert.match(excerpt("system_precheck_failed")[0]!, /devops guy d1 "Duty d1": its newest run's precheck failed: exit 1: TypeError: fetch failed/);
  assert.match(excerpt("system_precheck_failed")[1]!, /precheck ran 400 s against a target of 120 s/);
  assert.match(excerpt("job_waits_account")[0]!, /d10 "Duty d10": its job Duty d10 duty waits for a model account, started 11-22 06:00 KST/);
  assert.deepEqual(excerpt("fix_blames_check").map(text => text.slice(0, 20)), ["devops guy p91 (d2/u"]);
  assert.deepEqual(out.flagged.filter(flag => flag.kind === "met_leaving_out").map(flag => flag.sig), ["ag_devops-guy/d9/leaves-out", "ag_devops-guy/d14/leaves-out"]);
});

test("d7's definition counts the three readings of p60 and quotes the owner's posts with their message ids", () => {
  assert.deepEqual(D7.metrics.map(metric => [metric.key, metric.headline ?? false]), [["agents_off_pattern", true], ["checks_blind", false], ["problems_returned", false], ["duty_system_faults", false]]);
  for (const key of ["wiki_clutter", "misses_unfixed_24h", "runs_without_n", "past_problems_not_measured", "duty_jobs_waiting_account", "duties_met_leaving_out"]) assert.ok(D7.readings.some(reading => reading.key === key), key);
  assert.match(D7.ownerWords, /daily monitor yourself of whether children agents are doing fine and fixing recurring issues, duties not being kept due to poor Duty system implementation\?\n\(#1124-cost-management p60, msg mx0bgshc/);
  assert.match(D7.ownerWords, /@agent factory fix devops guy, its partly YOUR responsibility if something like this happens\n\(#1124-cost-management p56, msg mx0b5pkg/);
});
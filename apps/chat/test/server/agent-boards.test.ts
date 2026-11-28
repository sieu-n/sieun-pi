/**
 * Agent factory's d5 precheck (scripts/duties/agent-boards.ts) sums every agent's stuck steps and goal gaps from GET /steps, flags each one
 * with why it is stuck, and counts a check-in with no run in 1.5 intervals as late unless it is paused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/agent-boards.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_REVIEW_N_SINCE, agentBoards, agentPattern, askHeld, asksTo, duplicateJobs, ongoingAsk, dutyCoverage, liveDuty, overdueDuty, pauseReason, readAreas, readWiki, sampleSize, stalePause, unfixedMisses, wikiClutter,
  type Ask, type DutyRow,
} from "../../scripts/duties/agent-boards.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    agents_uncovered: 0, areas_uncovered: 0, agents_without_area: 1, duties_paused: 0, duties_overdue: 0, asks_unheld: 0, pauses_stale: 0, met_on_zero: 0,
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
  ], [], NOW);
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
  ], [], NOW);
  assert.equal(paused.metrics.asks_unheld, 1);
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
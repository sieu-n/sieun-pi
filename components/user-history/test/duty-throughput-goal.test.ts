// Guards the Throughput goal achieved duty's numbers (scripts/duties/throughput-goal.ts), the Crawler VP chat's d9: the owner renamed it from
// Crawler running on 10-22 (msg mvj491h5, "Throughput goal achieved ( unified for all platform )"). Its headline counts the board's throughput
// goals prod misses, and it keeps his 10-19 duties for crawler-v3 (msg mvfe8foz): GeoNode at least 100 Mbps, nothing backlogging, and the crawler
// dashboards drawing ("Check the Observability and Metrics"), where on 10-19 at 15:55Z two panels read No data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardItem, GOOD_ROWS, REFRESH_SEEDS, type ThroughputData, backlogged, boardGoal, deploySlots, geonodeHours, geonodeMbps, goalRows, grew, interpolate, lastHalfHour,
  lagSlots, missed, panelQueries, panelState, refreshShares, refreshSql, report, slowestHour, writerLagAtRate } from "../scripts/duties/throughput-goal.ts";
import type { DutyMetric } from "../src/shared/chat-duties.ts";

const METRICS: DutyMetric[] = [
  { key: "throughput_goals_missed", label: "goals", op: "<=", target: 0, headline: true },
  { key: "geonode_mbps", label: "mbps", op: ">=", target: 100 },
  { key: "ig_queues_growing_6h", label: "queues", op: "<=", target: 0 },
  { key: "crawler_panels_blank", label: "panels", op: "<=", target: 0 },
  { key: "census_pg_writer_lag_max_24h", label: "writer lag", op: "<=", target: 5_000 },
] as DutyMetric[];
const NOW = Date.parse("2026-10-22T06:38:00Z");
const FROM = Date.parse("2026-10-21T15:03:00Z");
const TO = FROM + 30 * 60_000;
const GEO_TO = Date.parse("2026-10-22T06:00:00Z");
const GEO_FROM = GEO_TO - 24 * 3_600_000;
// The board as it stood on 10-22 at 06:10Z: p826 and p850 carry targets, p696 only its title, p683 is done with its target.
const BOARD: BoardItem[] = [
  { id: "p826", text: "Instagram profiles crawl at 10,000 a minute, held 6 h straight (owner 10-19, p1)", target: { target: 10_000 } },
  { id: "p681", text: "TikTok Shop: every shop, product and creator indexed, and each re-read every week", target: { target: 100 },
    children: [{ id: "p696", text: "Push TikTok Shop good products a minute to 2,000 now: drop the per-loop Redis SCAN, run 4 crawler processes, re-measure" }] },
  { id: "p680", text: "Meta Ads", children: [{ id: "p850", text: "Stop Meta Ads advertiser walks from going more than a day overdue", target: { target: 7 } }] },
  { id: "p683", status: "done", text: "Refresh every read Instagram account at least weekly", target: { target: 1 } },
];
const HALF = { read: 198_769, past7: 126, past14: 1, past7History: 60 };
const base = (over: Partial<ThroughputData> = {}): ThroughputData => ({ now: NOW, errors: [], geoFrom: GEO_FROM, geoTo: GEO_TO, ...over });

test("a goal number comes from the item's target, else the number in its title, and a missing item has none", () => {
  assert.deepEqual(boardGoal(BOARD, "p826"), { goal: 10_000, source: "target" });
  assert.deepEqual(boardGoal(BOARD, "p696"), { goal: 2_000, source: "title" });
  assert.deepEqual(boardGoal(BOARD, "p850"), { goal: 7, source: "target" });
  assert.equal(boardGoal(BOARD, "p999"), null);
});

test("the slowest rolling hour counts a slot with no rows as a stop (10-22 01:00Z, when the dashboard gauge held 11,100)", () => {
  const from = Date.parse("2026-10-22T00:00:00Z");
  const slots = Array.from({ length: 72 }, (_, index) => ({ slot: from + index * 300_000, good: 50_000 }));
  assert.equal(slowestHour(slots, from, from + 6 * 3_600_000), 10_000);
  const stopped = slots.filter((_, index) => index < 12 || index >= 24);
  assert.equal(slowestHour(stopped, from, from + 6 * 3_600_000), 0);
  assert.equal(slowestHour([], from, from + 6 * 3_600_000), 0);
});

test("prod's deploy lock leaves its slots out of the slowest hour (10-22 00:55 to 01:52Z, when d9 read 920 profiles a minute)", () => {
  const from = Date.parse("2026-10-22T01:10:00Z");
  const to = from + 6 * 3_600_000;
  const slot = (at: string): number => Date.parse(`2026-10-22T${at}:00Z`);
  // The prod lock gauge's 5-minute max at each point: held at the 01:15 to 01:55 points, then clear, with a stale 7,200 s lock at 04:00.
  const points: [number, number][] = [["01:10", 732], ["01:15", 1_037], ["01:30", 1_947], ["01:50", 3_130], ["01:55", 3_191], ["02:00", 0], ["04:00", 7_200]]
    .map(([at, seconds]) => [slot(at as string), seconds as number]);
  const deploys = deploySlots(points);
  assert.deepEqual([...deploys].sort(), [slot("01:05"), slot("01:10"), slot("01:25"), slot("01:45"), slot("01:50")]);
  // Census-sized slots, 50,000 a slot (10,000 a minute), and none while the deploy held the lock from 01:10 to 01:55.
  const lock = new Set(Array.from({ length: 9 }, (_, index) => from + index * 300_000));
  const slots = Array.from({ length: 72 }, (_, index) => ({ slot: from + index * 300_000, good: lock.has(from + index * 300_000) ? 0 : 50_000 }));
  assert.equal(slowestHour(slots, from, to), Math.round((3 * 50_000) / 60));
  assert.equal(slowestHour(slots, from, to, lock), 10_000);
  // A stop outside a deploy still counts.
  const stopped = slots.map(s => s.slot === slot("03:35") ? { ...s, good: 0 } : s);
  assert.equal(slowestHour(stopped, from, to, lock), Math.round((11 * 50_000) / 60));
  // Under an hour left outside deploys reads the mean of what is left.
  assert.equal(slowestHour(slots.slice(0, 15), from, from + 15 * 300_000, lock), 10_000);
  assert.equal(lastHalfHour(slots, to), 10_000);
});

test("Instagram counts profile rows on every read path, the table p826's target reads, and TikTok Shop its good products", () => {
  assert.deepEqual(GOOD_ROWS.instagram, { table: "crawler.instagram_account_snapshots", where: "" });
  assert.match(GOOD_ROWS.tiktokShop.where, /^kind = 'product' AND outcome = 'ok' AND $/);
  const rows = goalRows(base({ board: BOARD, igSlowest: 4_423, igLast30: 11_660, deployMinutes: 45 }));
  assert.match(rows[0]!.reads, /outside 45 min of prod deploys/);
  assert.match(rows[0]!.extra!, /11,660 a minute in the last 30 min/);
});

test("every throughput goal on the board is one row, and the headline counts the rows prod misses", () => {
  const data = base({ board: BOARD, igSlowest: 5_157, ttsSlowest: 1_960, meta: { due: 2_780_536, finished24h: 53_570 }, refresh: [HALF, { ...HALF, past7: 127, past14: 2 }] });
  const rows = goalRows(data);
  assert.deepEqual(rows.map(row => [row.item, missed(row)]), [["p826", true], ["p696", true], ["p850", true], ["p683", false], ["p829", false]]);
  assert.equal(Math.round(rows[2]!.goal!), 276);
  const out = report(data, METRICS);
  assert.equal(out.metrics.throughput_goals_missed, 3);
  assert.ok(out.flagged!.some(item => item.item === "p696" && item.excerpt.includes("from its title")));
  const met = report(base({ ...data, igSlowest: 10_400, ttsSlowest: 2_100, meta: { due: 300_000, finished24h: 53_570 } }), METRICS);
  assert.equal(met.metrics.throughput_goals_missed, 0);
});

test("a goal whose read or board number failed leaves the headline unmeasured instead of counting a miss", () => {
  const noBoard = report(base({ igSlowest: 10_400, ttsSlowest: 2_100, meta: { due: 1, finished24h: 53_570 }, refresh: [HALF], errors: [{ source: "board", message: "ENOENT" }] }), METRICS);
  assert.ok(noBoard.metrics.throughput_goals_missed! > 1000);
  assert.equal(noBoard.flagged![0]!.kind, "unmeasured");
});

test("GeoNode reads the slowest full hour of the 24 h, and an hour with no ledger rows reads near 0", () => {
  const census = { jobs: 0, bad: 0, att: 0, okAtt: 0, wire: 45_000_000_000 };
  const hours = Array.from({ length: 24 }, (_, index) => ({ hour: GEO_FROM + index * 3_600_000, census, proxy: [{ lane: "instagram_census", wire: 0, newSessions: 0 }] }));
  assert.deepEqual(geonodeHours(hours, [], GEO_FROM, GEO_TO).map(h => h.mbps), Array(24).fill(100));
  const gap = geonodeHours(hours.filter((_, index) => index !== 19), [], GEO_FROM, GEO_TO);
  assert.equal(Math.min(...gap.map(h => h.mbps)), 0);
  const out = report(base({ geoHours: hours.filter((_, index) => index !== 19), adLibrary: [] }), METRICS);
  assert.equal(out.metrics.geonode_mbps, 0);
});

test("GeoNode Mbps counts HTTP bytes and 8,678 bytes per new connection, with census connections inferred from its jobs", () => {
  const census = { jobs: 100, bad: 60, att: 400, okAtt: 40, wire: 0 };
  // 100 jobs + 400 tries - 40 ok tries - 60 bad jobs = 400 connections; 400 * 8,678 bytes over 1,800 s.
  assert.equal(geonodeMbps(census, [], [], FROM, TO), Math.round((400 * 8678 * 8) / 1800 / 1e6 * 10) / 10);
  assert.equal(geonodeMbps({ ...census, wire: 22_500_000_000 }, [{ lane: "instagram_census", wire: 0, newSessions: 0 }], [], FROM, TO), 100);
});

test("a queue backlogs while its 30-minute low stands over 80k even as it falls (p827; media.fetch at 5.5M read 0 on 10-22)", () => {
  const media = { family: "kafka lag", name: "media.fetch/image-worker", now: 5_637_727, ago6h: 7_900_000, slope6h: -100, low: 5_534_617, low6h: 7_800_000 };
  assert.equal(grew(media), false);
  assert.equal(backlogged(media), true);
  // 10-22 07:20Z: census-crawl's buffer stood at 12,863 with a low of 8,197; its largest 30-minute low in 3 days was 51,376.
  assert.equal(backlogged({ family: "kafka lag", name: "instagram.crawl/instagram-census-crawl", now: 12_863, ago6h: 12_000, slope6h: 1, low: 51_376, low6h: 8_000 }), false);
  // 10-22 07:20Z: the profile outbox held 148k with a low of 88k while its oldest write waited 69 s, a backfill.
  assert.equal(backlogged({ family: "search sync outbox", name: "profile", now: 147_828, ago6h: 11_000, slope6h: 5, low: 88_227, low6h: 3_000, wait: 69 }), false);
  assert.equal(backlogged({ family: "dead letters", name: "media.fetch.dlq", now: 90_000, ago6h: 90_000, slope6h: 0 }), true);
});

test("a queue grows only past 10% and about a minute of census intake, with its slope up", () => {
  assert.equal(grew({ family: "kafka lag", name: "crawl.videos/video-writers", now: 280, ago6h: 97, slope6h: 30 }), false);
  assert.equal(grew({ family: "kafka lag", name: "media.fetch/image-worker", now: 30_400_000, ago6h: 37_400_000, slope6h: -1e6 }), false);
  assert.equal(grew({ family: "kafka lag", name: "instagram.observed/instagram-census-os", now: 200_000, ago6h: 100_000, slope6h: 15_000 }), true);
  assert.equal(grew({ family: "kafka lag", name: "instagram.observed/instagram-census-os", now: 10_400_000, ago6h: null, slope6h: null }), false);
  // 10-20 07:30Z: the profile outbox fills and drains with census intake, so its mean doubled while its 30-minute low stayed under the line.
  assert.equal(grew({ family: "search sync outbox", name: "profile", now: 22_350, ago6h: 11_502, slope6h: 1, low: 14_124, low6h: 7_844 }), false);
  // 10-20 07:30Z: crawl.videos rose at its low point too, so it is a backlog.
  assert.equal(grew({ family: "kafka lag", name: "crawl.videos/video-writers", now: 652_138, ago6h: 447_386, slope6h: 20, low: 532_587, low6h: 437_735 }), true);
  // 10-20 16:15Z: the profile restage's backfill lane swelled the outbox while its oldest write waited 76 s, so no write is backlogged.
  assert.equal(grew({ family: "search sync outbox", name: "profile", now: 336_791, ago6h: 23_117, slope6h: 7.6, low: 282_242, low6h: 15_534, wait: 76 }), false);
  // 10-19 21:00Z: the profile outbox backlog held its oldest write 5,525 s.
  assert.equal(grew({ family: "search sync outbox", name: "profile", now: 721_958, ago6h: 9_000, slope6h: 30, low: 600_000, low6h: 5_000, wait: 5_525 }), true);
});

test("the run reads every metric, and a failed source misses instead of reading green", () => {
  const census = { jobs: 190_193, bad: 144_356, att: 2_000_000, okAtt: 40_000, wire: 0 };
  const data = base({ board: BOARD, igSlowest: 10_400, ttsSlowest: 2_100, meta: { due: 300_000, finished24h: 53_570 }, refresh: [HALF],
    geoHours: [{ hour: GEO_FROM, census, proxy: [] }], adLibrary: [],
    queues: [{ family: "kafka lag", name: "media.fetch/image-worker", now: 30_400_000, ago6h: 37_400_000, slope6h: -1e6 }],
    panels: [{ dashboard: "Crawler · Throughput", title: "Instagram profiles", state: "no data", detail: "" },
      { dashboard: "Crawler · Health", title: "Profiles a minute", state: "ok", detail: "" }] });
  const out = report(data, METRICS);
  assert.equal(out.metrics.throughput_goals_missed, 0);
  assert.equal(out.metrics.ig_job_fail_pct, undefined);
  assert.ok(out.flagged!.some(item => item.kind === "errors" && item.excerpt.includes("75.9%")));
  assert.equal(out.metrics.ig_queues_growing_6h, 1);
  assert.ok(out.flagged!.some(item => item.kind === "backlog" && item.excerpt.startsWith("1 of 1 Instagram queues backlog, over 80k")));
  assert.equal(out.metrics.crawler_panels_blank, 1);
  const broken = report(base({ board: BOARD, errors: [{ source: "queues", message: "Grafana HTTP 502" }] }), METRICS);
  assert.ok(broken.metrics.geonode_mbps! < 0 && broken.metrics.ig_queues_growing_6h! > 1000 && broken.metrics.throughput_goals_missed! > 1000);
  assert.equal(broken.flagged![0]!.kind, "unmeasured");
});

test("ig_queues_growing_6h dates a growing or unread queue count at this run and gives no lastEventAt at 0 (10-20 07:40Z d9 push)", () => {
  const videos = { family: "kafka lag", name: "crawl.videos/video-writers", now: 652_138, ago6h: 447_386, slope6h: 20, low: 532_587, low6h: 437_735 };
  const run = (queues: ThroughputData["queues"], errors: ThroughputData["errors"] = []) => report(base({ errors, ...queues ? { queues } : {} }), METRICS);
  assert.deepEqual(run([videos]).lastEventAt, { ig_queues_growing_6h: NOW });
  assert.deepEqual(run(undefined, [{ source: "queues", message: "Grafana HTTP 502" }]).lastEventAt, { ig_queues_growing_6h: NOW });
  assert.equal(run([{ ...videos, now: 60_000, low: 40_000 }]).lastEventAt, undefined);
});

test("a panel runs as Grafana draws it: quoted variables, hidden targets an expression reads, and a value in any shown query", () => {
  // The Crawler and data dashboard's jobs panel filters on ${env:sqlstring}, which ClickHouse rejected as a bare word before it was quoted.
  assert.equal(interpolate("WHERE ${env:sqlstring} = 'production' AND $service = x", new Map([["env", "production"], ["service", "crawler-v3"]])),
    "WHERE 'production' = 'production' AND crawler-v3 = x");
  const panel = { targets: [{ refId: "rate", hide: true, datasource: { uid: "estate_ch_prod" } }, { refId: "cap", hide: true, datasource: { uid: "estate_prometheus" } },
    { refId: "share", datasource: { type: "__expr__", uid: "__expr__" }, expression: "$rate / $cap" }] };
  const { queries, shown } = panelQueries(panel, new Map());
  // Crawler · Sources picks its Postgres source as estate_pg_${env:text}, where env's value is a Prometheus uid and its text is prod.
  const picked = panelQueries({ targets: [{ refId: "A", datasource: { uid: "estate_pg_${env:text}" }, rawSql: "SELECT '${env:text}'" }] },
    new Map([["env", "estate_prometheus"], ["env:text", "prod"]]));
  assert.deepEqual(picked.queries.map(query => [query.datasource, query.rawSql]), [[{ uid: "estate_pg_prod" }, "SELECT 'prod'"]]);
  assert.deepEqual(queries.map(query => query.refId), ["rate", "cap", "share"]);
  assert.deepEqual(shown, ["share"]);
  const frame = (values: unknown[][]) => ({ frames: [{ data: { values } }] });
  assert.equal(panelState({ results: { share: frame([[1, 2], [null, 0.4]]) } }, shown).state, "ok");
  assert.equal(panelState({ results: { share: { frames: [] } } }, shown).state, "no data");
  assert.equal(panelState({ results: { share: { error: "Query data error" } } }, shown).state, "error");
  assert.equal(panelState({ results: { A: frame([[3]]) } }, ["A"]).state, "ok");
});

test("the refresh age sums ten 0.1% samples, leaves GONE rows out and reads unmeasured when none answered (p683, p829, 10-21)", () => {
  assert.equal(REFRESH_SEEDS.length, 10);
  assert.equal(refreshSql(103).match(/state <> 'gone'/g)!.length, 4);
  assert.match(refreshSql(103), /SYSTEM\(0\.1\) REPEATABLE\(103\)/);
  // 10-21 06:05Z: 253 of 397,538 sampled read rows past 7 days, 3 past 14.
  const shares = refreshShares([HALF, { ...HALF, past7: 127, past14: 2 }])!;
  assert.equal(shares.past7Pct, 0.064);
  assert.equal(shares.within14Pct, 99.999);
  assert.equal(refreshShares([]), null);
  const read = goalRows(base({ board: BOARD, refresh: [HALF] })).filter(row => row.item === "p683" || row.item === "p829");
  assert.deepEqual(read.map(row => missed(row)), [false, false]);
  const failed = goalRows(base({ board: BOARD, errors: [{ source: "refresh age", message: "Grafana HTTP 400: canceling statement due to statement timeout" }] }));
  assert.deepEqual(failed.filter(row => row.item === "p683" || row.item === "p829").map(row => row.value), [null, null]);
});

test("the census writer's worst lag counts only slots at p826's rate outside deploys (p895, 10-22 06:00-08:00Z)", () => {
  const from = Date.parse("2026-10-22T06:00:00Z");
  const at = (index: number): number => from + index * 300_000;
  // 10,900 a minute in slots 0-2, 4,000 in slot 3, and slot 2 under a deploy.
  const ig = [0, 1, 2, 3].map(index => ({ slot: at(index), good: (index === 3 ? 4_000 : 10_900) * 5 }));
  // A lag point at t covers the slot that ends at t.
  const lag = lagSlots([[at(1), 3_000], [at(2), 17_425], [at(3), 40_000], [at(4), 90_000]]);
  assert.deepEqual(writerLagAtRate(ig, lag, new Set([at(2)]), 10_000), { lag: 17_425, slot: at(1), slots: 2 });
  assert.equal(writerLagAtRate(ig.map(s => ({ ...s, good: 4_000 * 5 })), lag, new Set(), 10_000), null);
});

test("the writer lag metric reads 24 h of slots, and no slot at p826's rate leaves it unmeasured", () => {
  const from = NOW - 24 * 3_600_000;
  const slot = Math.floor(from / 300_000) * 300_000 + 300_000;
  const met = report(base({ board: BOARD, igSlots24h: [{ slot, good: 55_000 }], writerLag: [{ slot, good: 2_613 }], deploys24h: [] }), METRICS);
  assert.equal(met.metrics.census_pg_writer_lag_max_24h, 2_613);
  assert.match(met.flagged!.find(f => f.kind === "writer_lag")!.excerpt, /lagged 2,613 records at most over 24 h/);
  const slow = report(base({ board: BOARD, igSlots24h: [{ slot, good: 20_000 }], writerLag: [{ slot, good: 50_000 }], deploys24h: [] }), METRICS);
  assert.ok(slow.metrics.census_pg_writer_lag_max_24h! > 5_000);
  assert.ok(slow.flagged!.some(f => f.kind === "unmeasured" && f.excerpt.includes("census_pg_writer_lag_max_24h")));
});

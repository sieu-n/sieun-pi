// Guards the Crawler running duty's numbers (scripts/duties/crawler-running.ts), set up for the Crawler VP chat on 10-19 from the owner's duties
// for crawler-v3 (msg mvfe8foz): GeoNode at least 100 Mbps, nothing backlogging, and the crawler dashboards drawing ("Check the Observability and
// Metrics"), where on 10-19 at 15:55Z two panels read No data: the oldest crawl task wait, whose series no longer exists, and the media worker
// memory share, whose workers have no memory limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RunningData, geonodeMbps, grew, interpolate, panelQueries, panelState, report } from "../scripts/duties/crawler-running.ts";
import type { DutyMetric } from "../src/shared/chat-duties.ts";

const METRICS: DutyMetric[] = [
  { key: "ig_profiles_per_min", label: "profiles", op: ">=", target: 1000, headline: true },
  { key: "geonode_mbps", label: "mbps", op: ">=", target: 100 },
  { key: "ig_queues_growing_6h", label: "queues", op: "<=", target: 0 },
  { key: "crawler_panels_blank", label: "panels", op: "<=", target: 0 },
] as DutyMetric[];
const NOW = Date.parse("2026-10-19T15:38:00Z");
const FROM = NOW - 35 * 60_000;
const TO = NOW - 5 * 60_000;

test("GeoNode Mbps counts HTTP bytes and 8,678 bytes per new connection, with census connections inferred from its jobs", () => {
  const census = { jobs: 100, bad: 60, att: 400, okAtt: 40, wire: 0 };
  // 100 jobs + 400 tries - 40 ok tries - 60 bad jobs = 400 connections; 400 * 8,678 bytes over 1,800 s.
  assert.equal(geonodeMbps(census, [], [], FROM, TO), Math.round((400 * 8678 * 8) / 1800 / 1e6 * 10) / 10);
  assert.equal(geonodeMbps({ ...census, wire: 22_500_000_000 }, [{ lane: "instagram_census", wire: 0, newSessions: 0 }], [], FROM, TO), 100);
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
});

test("the run reads every metric, and a failed source misses instead of reading green", () => {
  const data: RunningData = { now: NOW, from: FROM, to: TO, errors: [], profiles: 50_211,
    census: { jobs: 190_193, bad: 144_356, att: 2_000_000, okAtt: 40_000, wire: 0 }, proxy: [], adLibrary: [],
    queues: [{ family: "kafka lag", name: "media.fetch/image-worker", now: 30_400_000, ago6h: 37_400_000, slope6h: -1e6 }],
    panels: [{ dashboard: "Crawler · Overview", title: "How long has the oldest crawl task waited?", state: "no data", detail: "" },
      { dashboard: "Crawler · Pipeline", title: "Profiles a minute", state: "ok", detail: "" }] };
  const out = report(data, METRICS);
  assert.equal(out.metrics.ig_profiles_per_min, 1674);
  assert.equal(out.metrics.ig_job_fail_pct, undefined);
  assert.ok(out.flagged!.some(item => item.kind === "errors" && item.excerpt.includes("75.9%")));
  assert.equal(out.metrics.ig_queues_growing_6h, 0);
  assert.equal(out.metrics.crawler_panels_blank, 1);
  const broken = report({ now: NOW, from: FROM, to: TO, errors: [{ source: "queues", message: "Grafana HTTP 502" }], profiles: 50_211 }, METRICS);
  assert.ok(broken.metrics.geonode_mbps! < 0 && broken.metrics.ig_queues_growing_6h! > 1000);
  assert.equal(broken.flagged![0]!.kind, "unmeasured");
});

test("a panel runs as Grafana draws it: quoted variables, hidden targets an expression reads, and a value in any shown query", () => {
  // The Crawler and data dashboard's jobs panel filters on ${env:sqlstring}, which ClickHouse rejected as a bare word before it was quoted.
  assert.equal(interpolate("WHERE ${env:sqlstring} = 'production' AND $service = x", new Map([["env", "production"], ["service", "crawler-v3"]])),
    "WHERE 'production' = 'production' AND crawler-v3 = x");
  const panel = { targets: [{ refId: "rate", hide: true, datasource: { uid: "estate_ch_prod" } }, { refId: "cap", hide: true, datasource: { uid: "estate_prometheus" } },
    { refId: "share", datasource: { type: "__expr__", uid: "__expr__" }, expression: "$rate / $cap" }] };
  const { queries, shown } = panelQueries(panel, new Map());
  assert.deepEqual(queries.map(query => query.refId), ["rate", "cap", "share"]);
  assert.deepEqual(shown, ["share"]);
  const frame = (values: unknown[][]) => ({ frames: [{ data: { values } }] });
  assert.equal(panelState({ results: { share: frame([[1, 2], [null, 0.4]]) } }, shown).state, "ok");
  assert.equal(panelState({ results: { share: { frames: [] } } }, shown).state, "no data");
  assert.equal(panelState({ results: { share: { error: "Query data error" } } }, shown).state, "error");
  assert.equal(panelState({ results: { A: frame([[3]]) } }, ["A"]).state, "ok");
});

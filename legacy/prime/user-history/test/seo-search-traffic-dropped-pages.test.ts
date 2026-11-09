// Guards the 10-13 drop nobody saw for days: /ja/blog/how-much-does-youtube-pay-per-view fell from 136 to 2 Google impressions a day
// and /blog/instagram-algorithm from 26 to 0, and the 7-against-14-day rule with a 20 a day floor caught neither by the 10-14 final day.
// Also guards the 10-18 false drop: /blog/will-ai-kill-us-all's launch days (1,248 and 263) made its usual 4 to 56 a day read as a fall.
import assert from "node:assert/strict";
import { test } from "node:test";
import { droppedPages, readNoindex, visitsOutput, type GscRead, type PagesDaily, type QueriesDaily } from "../scripts/duties/seo-search-visits.ts";

const JA_PAY = "https://virev.ai/ja/blog/how-much-does-youtube-pay-per-view";
const IG_ALGO = "https://virev.ai/blog/instagram-algorithm";
const STEADY = "https://virev.ai/blog/fitness-influencers";
const LAUNCH = "https://virev.ai/blog/will-ai-kill-us-all";
// Search Console impressions per page and day (final data, read 10-18), with each page's every day that had any.
const days: Record<string, [string, number][]> = {
  [JA_PAY]: [["10-08", 45], ["10-09", 150], ["10-10", 218], ["10-11", 235], ["10-12", 136], ["10-13", 2], ["10-15", 2], ["10-16", 2]],
  [IG_ALGO]: [["10-08", 2], ["10-09", 5], ["10-10", 25], ["10-11", 44], ["10-12", 26], ["10-15", 6], ["10-16", 3]],
  [LAUNCH]: [["10-08", 1248], ["10-09", 263], ["10-10", 41], ["10-11", 56], ["10-12", 20], ["10-13", 11], ["10-14", 7], ["10-15", 4], ["10-16", 53], ["10-17", 42]],
  [STEADY]: [["10-02", 4], ["10-03", 65], ["10-04", 56], ["10-05", 117], ["10-06", 105], ["10-07", 145], ["10-08", 118], ["10-09", 172], ["10-10", 89], ["10-11", 74], ["10-12", 57], ["10-13", 30], ["10-14", 33], ["10-15", 91], ["10-16", 111]],
};
const upTo = (end: string): PagesDaily => {
  const start = new Date(Date.parse(end) - 16 * 86_400_000).toISOString().slice(0, 10);
  const rows = Object.entries(days).flatMap(([page, list]) => list.map(([day, impressions]) => ({ page, date: `2026-${day}`, impressions })))
    .filter(row => row.date >= start && row.date <= end);
  return { start, end, rows };
};

test("dropped_pages flags both 10-13 drops by the 10-16 final day and leaves a steady page and a settled launch spike alone", () => {
  assert.deepEqual(droppedPages(upTo("2026-10-15")).map(page => page.page).filter(page => page !== LAUNCH), [JA_PAY, IG_ALGO]);
  for (const end of ["2026-10-16", "2026-10-17"]) assert.deepEqual(droppedPages(upTo(end)).map(page => page.page), [JA_PAY, IG_ALGO], end);
  assert.deepEqual(droppedPages(upTo("2026-10-16")), [{ page: JA_PAY, baseDaily: 147.8, recentDaily: 1.3 }, { page: IG_ALGO, baseDaily: 23.8, recentDaily: 3 }]);
  const gsc: GscRead = { today: "2026-10-18", last_final: "2026-10-16", pages: upTo("2026-10-16"),
    d7: { start: "2026-10-10", end: "2026-10-16", clicks: 70, impressions: 9000, position: 9 } };
  const output = visitsOutput({ gsc }, Date.parse("2026-10-18T00:00:00Z"));
  assert.equal(output.metrics.dropped_pages, 2);
  assert.equal(output.metrics.google_clicks_d7, 10);
  assert.match(output.flagged!.find(slice => slice.kind === "dropped_pages")!.excerpt,
    /2026-09-30\.\.2026-10-13 against 2026-10-14\.\.2026-10-16.*how-much-does-youtube-pay-per-view 147\.8 to 1\.3, .*instagram-algorithm 23\.8 to 3/);
  assert.equal(visitsOutput({ gsc: { error: "HTTP 500" } }, 0).metrics.dropped_pages, 999_999);
});

test("a last final day 4 or 5 Seoul days old still measures, and only an older one is a source error (11-08 03:22 KST d1 read 11-04)", () => {
  const read = (today: string): GscRead => ({ today, last_final: "2026-11-04", pages: upTo("2026-11-04"),
    d7: { start: "2026-10-29", end: "2026-11-04", clicks: 255, impressions: 18191, position: 9 } });
  for (const today of ["2026-11-08", "2026-11-09"]) {
    const output = visitsOutput({ gsc: read(today) }, 0);
    assert.ok(output.metrics.google_clicks_d7! > 0, today);
    assert.notEqual(output.metrics.dropped_pages, 999_999, today);
  }
  assert.equal(visitsOutput({ gsc: read("2026-11-10") }, 0).metrics.dropped_pages, 999_999);
});

test("a page that answers robots noindex is left out of dropped_pages, since we asked Google to drop it", async () => {
  assert.deepEqual(droppedPages(upTo("2026-10-16"), new Set([IG_ALGO])).map(page => page.page), [JA_PAY]);
  const html = (robots: string): Response => new Response(`<html><head>${robots}</head></html>`, { headers: { "content-type": "text/html" } });
  const get = (async (url: string | URL | Request) => {
    const page = String(url);
    if (page === IG_ALGO) return html('<meta name="robots" content="noindex,follow"/>');
    if (page === STEADY) return new Response("x", { headers: { "x-robots-tag": "noindex" } });
    if (page === LAUNCH) throw new Error("connect timeout");
    return html('<meta name="robots" content="index,follow"/>');
  }) as typeof fetch;
  assert.deepEqual(await readNoindex([JA_PAY, IG_ALGO, STEADY, LAUNCH], get), [IG_ALGO, STEADY]);
});

test("#fragment rows of one page count as that one page (11-09: 9 of 21 dropped pages were jump links of one article)", () => {
  const PAGE = "https://virev.ai/blog/average-instagram-followers";
  const rows = ["", "#by-country", "#for-creators"].flatMap(fragment => Array.from({ length: 17 }, (_, i) => {
    const date = new Date(Date.parse("2026-10-24") + i * 86_400_000).toISOString().slice(0, 10);
    return { page: PAGE + fragment, date, impressions: date >= "2026-11-07" ? 0 : 4 };
  }));
  const daily: PagesDaily = { start: "2026-10-24", end: "2026-11-09", rows };
  assert.deepEqual(droppedPages(daily), [{ page: PAGE, baseDaily: 12, recentDaily: 0 }]);
  assert.deepEqual(droppedPages(daily, new Set([PAGE])), []);
});

test("a dropped page whose named searches another virev.ai page took is left out (11-06: top fitness influencers moved to a country list)", () => {
  const LIST = "https://virev.ai/blog/fitness-influencers", COUNTRY = "https://virev.ai/en/top-fitness-influencers-in-singapore";
  const GONE = "https://virev.ai/blog/yoga-influencers";
  const dates = Array.from({ length: 17 }, (_, i) => new Date(Date.parse("2026-10-21") + i * 86_400_000).toISOString().slice(0, 10));
  const recent = (date: string): boolean => date >= "2026-11-04";
  const pages: PagesDaily = { start: dates[0]!, end: dates.at(-1)!, rows: dates.flatMap(date => [
    { page: LIST, date, impressions: recent(date) ? 6 : 70 },
    { page: GONE, date, impressions: recent(date) ? 3 : 24 },
    ...(recent(date) ? [{ page: COUNTRY, date, impressions: 120 }] : []),
  ]) };
  const queries: QueriesDaily = { start: pages.start, end: pages.end, rows: dates.flatMap(date => [
    ...(recent(date) ? [{ query: "top fitness influencers", page: COUNTRY, date, impressions: 30 }] : [{ query: "top fitness influencers", page: LIST, date, impressions: 25 }]),
    ...(recent(date) ? [] : [{ query: "yoga influencers", page: GONE, date, impressions: 8 }]),
  ]) };
  const gsc: GscRead = { today: "2026-11-09", last_final: "2026-11-06", pages, queries,
    d7: { start: "2026-10-31", end: "2026-11-06", clicks: 262, impressions: 18979, position: 12 } };
  const output = visitsOutput({ gsc }, 0);
  assert.equal(output.metrics.dropped_pages, 1);
  const excerpt = output.flagged!.find(slice => slice.kind === "dropped_pages")!.excerpt;
  assert.match(excerpt, /yoga-influencers 24 to 3\./);
  assert.match(excerpt, /took the named searches they lost: https:\/\/virev\.ai\/blog\/fitness-influencers lost 25 a day, others took 30/);
});

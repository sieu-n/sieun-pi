// Guards the 10-13 drop nobody saw for days: /ja/blog/how-much-does-youtube-pay-per-view fell from 136 to 2 Google impressions a day
// and /blog/instagram-algorithm from 26 to 0, and the 7-against-14-day rule with a 20 a day floor caught neither by the 10-14 final day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { droppedPages, visitsOutput, type GscRead, type PagesDaily } from "../scripts/duties/seo-search-visits.ts";

const JA_PAY = "https://virev.ai/ja/blog/how-much-does-youtube-pay-per-view";
const IG_ALGO = "https://virev.ai/blog/instagram-algorithm";
const STEADY = "https://virev.ai/blog/fitness-influencers";
// Search Console impressions per page and day (final data, read 10-18), with each page's every day that had any.
const days: Record<string, [string, number][]> = {
  [JA_PAY]: [["10-08", 45], ["10-09", 150], ["10-10", 218], ["10-11", 235], ["10-12", 136], ["10-13", 2], ["10-15", 2], ["10-16", 2]],
  [IG_ALGO]: [["10-08", 2], ["10-09", 5], ["10-10", 25], ["10-11", 44], ["10-12", 26], ["10-15", 6], ["10-16", 3]],
  [STEADY]: [["10-02", 4], ["10-03", 65], ["10-04", 56], ["10-05", 117], ["10-06", 105], ["10-07", 145], ["10-08", 118], ["10-09", 172], ["10-10", 89], ["10-11", 74], ["10-12", 57], ["10-13", 30], ["10-14", 33], ["10-15", 91], ["10-16", 111]],
};
const upTo = (end: string): PagesDaily => {
  const start = new Date(Date.parse(end) - 16 * 86_400_000).toISOString().slice(0, 10);
  const rows = Object.entries(days).flatMap(([page, list]) => list.map(([day, impressions]) => ({ page, date: `2026-${day}`, impressions })))
    .filter(row => row.date >= start && row.date <= end);
  return { start, end, rows };
};

test("dropped_pages flags both 10-13 drops by the 10-15 and 10-16 final days and leaves a steady page alone", () => {
  for (const end of ["2026-10-15", "2026-10-16"]) assert.deepEqual(droppedPages(upTo(end)).map(page => page.page), [JA_PAY, IG_ALGO], end);
  assert.deepEqual(droppedPages(upTo("2026-10-16")), [{ page: JA_PAY, baseDaily: 131, recentDaily: 1.3 }, { page: IG_ALGO, baseDaily: 17, recentDaily: 3 }]);
  const gsc: GscRead = { today: "2026-10-18", last_final: "2026-10-16", pages: upTo("2026-10-16"),
    d7: { start: "2026-10-10", end: "2026-10-16", clicks: 70, impressions: 9000, position: 9 } };
  const output = visitsOutput({ gsc }, Date.parse("2026-10-18T00:00:00Z"));
  assert.equal(output.metrics.dropped_pages, 2);
  assert.equal(output.metrics.google_clicks_d7, 10);
  assert.match(output.flagged!.find(slice => slice.kind === "dropped_pages")!.excerpt,
    /2026-09-30\.\.2026-10-13 against 2026-10-14\.\.2026-10-16.*how-much-does-youtube-pay-per-view 131 to 1\.3, .*instagram-algorithm 17 to 3/);
  assert.equal(visitsOutput({ gsc: { error: "HTTP 500" } }, 0).metrics.dropped_pages, 999_999);
});

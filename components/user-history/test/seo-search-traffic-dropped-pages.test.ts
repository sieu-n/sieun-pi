// Guards the 10-13 drop nobody saw for days: /ja/blog/how-much-does-youtube-pay-per-view fell from 136 to 2 Google impressions a day
// and /blog/instagram-algorithm to about 0, while the Search visits grow duty only read site totals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { droppedPages, visitsOutput, type GscRead, type PagesWindow } from "../scripts/duties/seo-search-visits.ts";

const JA_PAY = "https://virev.ai/ja/blog/how-much-does-youtube-pay-per-view";
const STEADY = "https://virev.ai/blog/fitness-influencers";
const SMALL = "https://virev.ai/blog/instagram-algorithm";
// Search Console totals per page: JA_PAY read 45, 150, 218, 235 and 136 impressions on 10-08 to 10-12, then 2 a day on three of the next days.
const base: PagesWindow = { start: "2026-09-29", end: "2026-10-12", rows: [
  { page: JA_PAY, impressions: 784 }, { page: STEADY, impressions: 782 }, { page: SMALL, impressions: 102 }] };
const recent: PagesWindow = { start: "2026-10-13", end: "2026-10-19", rows: [{ page: JA_PAY, impressions: 6 }, { page: STEADY, impressions: 485 }] };
const gsc: GscRead = { today: "2026-10-21", last_final: "2026-10-19", pages: { base, recent },
  d7: { start: "2026-10-13", end: "2026-10-19", clicks: 70, impressions: 9000, position: 9 } };

test("dropped_pages counts a page that had 20+ impressions a day and fell under 20% of that, and lists it in the detail", () => {
  assert.deepEqual(droppedPages(base, recent), [{ page: JA_PAY, baseDaily: 56, recentDaily: 0.9 }]);
  const output = visitsOutput({ gsc }, Date.parse("2026-10-21T00:00:00Z"));
  assert.equal(output.metrics.dropped_pages, 1);
  assert.equal(output.metrics.google_clicks_d7, 10);
  assert.match(output.flagged!.find(slice => slice.kind === "dropped_pages")!.excerpt, /how-much-does-youtube-pay-per-view 56 to 0\.9/);
  assert.equal(visitsOutput({ gsc: { error: "HTTP 500" } }, 0).metrics.dropped_pages, 999_999);
});

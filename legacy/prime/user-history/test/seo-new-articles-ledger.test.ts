// Guards the 10-30 d2 run. Scorers appended `check_of` lines (ledger lines 415-429) instead of filling the checked lines, and d2 listed
// those 15 scored checks as overdue. A `check_of` result now scores the check it names, once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerStats, type LedgerEntry } from "../scripts/duties/seo-new-articles.ts";

const TODAY = "2026-10-30";

test("a check_of line scores the check it names, once, and a liveness note before the check date does not", () => {
  const entries: LedgerEntry[] = [
    { date: "2026-10-08", worker: "yt-pay-ja", kind: "article", url: "https://virev.ai/ja/blog/a", check_date: "2026-10-29" },
    { date: "2026-10-15", worker: "google-clicks-1015/ctr-yt-sponsorship-over-time", kind: "fix", url: "https://virev.ai/blog/b", check_date: "2026-10-29" },
    { date: "2026-10-08", worker: "ctr-titles", kind: "experiment", url: "https://virev.ai/blog/c", check_date: "2026-10-22", result: "loss", result_date: "2026-10-24" },
    { date: "2026-10-16", worker: "never-scored", kind: "article", url: "https://virev.ai/blog/d", check_date: "2026-10-29" },
    { date: "2026-10-30", worker: "en-edition-tokyo-influencers", kind: "article", url: "https://virev.ai/blog/e", check_date: "2026-10-29" },
    { date: "2026-10-30", kind: "check", check_of: "2026-10-08 yt-pay-ja article line", result: "win" },
    { date: "2026-10-30", kind: "check", check_of: "2026-10-15 ctr-yt-sponsorship-over-time fix line", result: "flat" },
    { date: "2026-10-23", kind: "check", check_of: "2026-10-08 ctr-titles experiment line", result: "flat", result_date: "2026-10-23" },
    { date: "2026-10-28", kind: "check", check_of: "2026-10-30 en-edition-tokyo-influencers article line", result: "live" },
    { date: "2026-10-29", kind: "check", check_of: "d1 dropped_pages 2026-10-29 (p115)", result: "no fault on our side", result_date: "2026-10-29" },
  ];
  const stats = ledgerStats(entries, TODAY);
  assert.deepEqual(stats.overdue.map(entry => entry.worker), ["never-scored", "en-edition-tokyo-influencers"]);
  assert.equal(stats.scored, 4);
  assert.equal(stats.wins, 1);
});

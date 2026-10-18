// Guards the 10-16 and 10-17 wait: 35 creator pages sat about 25 h on the Mac tip before anyone pushed them to GitHub, and on 10-18 five
// blog changes waited 7 h, with no duty reading the gap between the tip and origin/sieun/dev.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readShip, unshippedBlogChanges, visitsOutput, type TipCommit } from "../scripts/duties/seo-search-visits.ts";

const NOW = Date.parse("2026-10-17T11:00:00Z");
const pages: TipCommit[] = Array.from({ length: 35 }, (_, index) => ({
  sha: `c${String(index).padStart(39, "0")}`, committedAt: Date.parse("2026-10-16T10:00:00Z") + index * 1000, subject: `feat(blog): creator page ${index}` }));
const fresh: TipCommit[] = Array.from({ length: 5 }, (_, index) => ({
  sha: `f${String(index).padStart(39, "0")}`, committedAt: NOW - 7 * 3_600_000, subject: `feat(blog): edition ${index}` }));

test("unshipped_blog_changes counts the apps/blog commits on the tip that GitHub lacks after 24 h, and reads the Mac tip ref on a box", async () => {
  assert.equal(unshippedBlogChanges([...fresh, ...pages], NOW).length, 35);
  const output = visitsOutput({ ship: { tipRef: "mac/sieun/dev", commits: [...fresh, ...pages] } }, NOW);
  assert.equal(output.metrics.unshipped_blog_changes, 35);
  assert.match(output.flagged!.find(slice => slice.kind === "unshipped_blog_changes")!.excerpt, /^35 of 40 apps\/blog commits on mac\/sieun\/dev .* c0{9} 25 h/);
  assert.equal(visitsOutput({ ship: { error: "git fetch: timeout" } }, NOW).metrics.unshipped_blog_changes, 999_999);

  const calls: string[][] = [];
  const read = await readShip(async args => {
    calls.push(args);
    if (args[0] === "log") return `${pages[0]!.sha}\t${pages[0]!.committedAt / 1000}\tfeat(blog): creator page 0\n`;
    return "";
  });
  assert.equal(calls[0]![0], "fetch");
  assert.deepEqual(read, { tipRef: "mac/sieun/dev", commits: [pages[0]] });
  assert.deepEqual(calls.at(-1)!.slice(1), ["--format=%H%x09%ct%x09%s", "refs/remotes/mac/sieun/dev", "^refs/remotes/origin/sieun/dev", "--", "apps/blog"]);
});

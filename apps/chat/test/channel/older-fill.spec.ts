import { expect, test, type Route } from "@playwright/test";
import { open } from "./helpers";

/**
 * A short page that opens at its bottom reads the page above it on its own. Nobody waits on that read, since the open's rows already show,
 * so it goes out as a read ahead and the d2 speed duty counts it nowhere. On 11-23 one such read of 564 ms counted as a wait on a job
 * page's open (~/work/p215-opens/summary.md). A read of the rows above that he scrolled for stays his wait.
 */
const ROOM = "ch_general";
const ITEMS = new RegExp(`/api/c/${ROOM}/items(\\?.*)?$`);
const FILL_MS = 700;

type Sample = { p: string; ms: number; bg?: string };

test("the read of older rows a short page fills itself with is a read ahead, and one he scrolled for is his wait", async ({ page }) => {
  const olderReads: string[] = [];
  await page.route(ITEMS, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before")) {
      olderReads.push(url.search);
      await new Promise((resolve) => setTimeout(resolve, FILL_MS));
      await route.fulfill({ json: { items: [], older: "e0" } });
      return;
    }
    const answer = await route.fetch();
    const page = (await answer.json()) as { items: unknown[]; older?: string };
    await route.fulfill({ response: answer, json: { ...page, items: page.items.slice(-6), older: "e1" } });
  });
  await open(page, `#/c/${ROOM}`);
  await page.waitForLoadState("networkidle");
  // A scroll event with no hand of his on the feed, as the open's own move to the bottom makes on a page under 240 px from its top.
  const feed = page.getByTestId("timeline").first();
  await feed.evaluate((el) => el.dispatchEvent(new Event("scroll")));
  await expect.poll(() => olderReads.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(FILL_MS + 300);

  // His wheel on the feed, then the scroll it makes: the read of the rows above is his.
  await feed.hover();
  await page.mouse.wheel(0, -100);
  await feed.evaluate((el) => el.dispatchEvent(new Event("scroll")));
  await expect.poll(() => olderReads.length, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(FILL_MS + 300);

  const batch = page.waitForRequest((r) => r.url().endsWith("/api/timings"));
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const samples = ((await batch).postDataJSON() as { samples: Sample[] }).samples.filter((s) => s.p === `/api/c/${ROOM}/items`);
  expect(samples.filter((s) => s.ms >= FILL_MS).map((s) => s.bg ?? "his wait")).toEqual(["ahead", "his wait"]);
});

import { expect, test } from "@playwright/test";
import { HARNESS_AGENT } from "./helpers";

/**
 * The owner reads :5184 from Korea. In the 24 h to 11-20 09:03 KST his board and duties calls took 203 and 213 ms at p50 and up to 1,040
 * and 947 ms, and each panel stayed empty for that long on every open. The page now reads an agent's board, duties, check-in and jobs
 * ahead, and its configuration while the Agents grid shows. These specs hold every later read of them, so only the page's kept answers
 * can fill the screen.
 */
const AGENT = `/api/agents/${HARNESS_AGENT}`;
const panelReads = ["board", "duties", "check-in", "agents", "config"].map((name) => `${AGENT}/${name}`);
const held = /\/api\/(agents|threads)\/[^/]+\/(board|duties|check-in|agents|config|for-me)(\?.*)?$/;
const settle = (page: import("@playwright/test").Page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

test("an agent's page and its board with duties and check-in show with no call in front of them", async ({ page }) => {
  const ahead = Promise.all(panelReads.map((path) => page.waitForResponse((r) => new URL(r.url()).pathname === path, { timeout: 20_000 })));
  await page.goto("/#/agents");
  await ahead;
  // The answers are in; one more turn of the page's loop keeps them.
  await settle(page);

  const asked: string[] = [];
  await page.route(held, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    asked.push(new URL(route.request().url()).pathname);
  });

  await page.locator(`[role="gridcell"][data-agent-id="${HARNESS_AGENT}"]`).click();
  await expect(page.getByTestId("agent-config").locator('[data-fact="host"]')).toBeVisible();

  await page.evaluate((hash) => { location.hash = hash; }, `#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await expect(page.getByRole("region", { name: "Duties" })).toContainText("Relay uptime");
  await expect(page.getByRole("region", { name: "Check-in" })).toContainText("Check-in every");
  // Each open asked for a refresh, and the screen filled while those calls hung.
  for (const path of panelReads) expect(asked).toContain(path);
});

test("a panel read ahead and its unchanged refresh are logged as background", async ({ page }) => {
  // A beacon's body cannot be read here, so the last batch goes out as the fetch the page falls back to.
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false;
  });
  const reads = panelReads.filter((path) => !path.endsWith("/config"));
  const ahead = Promise.all(reads.map((path) => page.waitForResponse((r) => new URL(r.url()).pathname === path, { timeout: 20_000 })));
  await page.goto("/#/agents");
  await ahead;
  await settle(page);
  const refreshed = Promise.all(reads.map((path) => page.waitForResponse((r) => new URL(r.url()).pathname === path)));
  await page.evaluate((hash) => { location.hash = hash; }, `#/board/${HARNESS_AGENT}`);
  await expect(page.getByRole("region", { name: "Check-in" })).toContainText("Check-in every");
  await refreshed;
  await settle(page);

  // The page posts its last batch of waits as it goes away.
  const batch = page.waitForRequest((r) => r.url().endsWith("/api/timings"));
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
  const samples = ((await batch).postDataJSON() as { samples: { p: string; bg?: string }[] }).samples;
  for (const path of reads) expect(samples.filter((s) => s.p === path).map((s) => s.bg ?? "waited"), path).toEqual(["ahead", "shown"]);
});

import { expect, resetFixture, test } from "./helpers";

test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

test("a For you request that never answers ends in an error with Retry, and Retry loads the asks", async ({ page }) => {
  test.setTimeout(45_000);
  let stall = true;
  await page.route("**/api/for-you", route => (stall ? undefined : route.fallback()));
  // The read leaves after the live socket opened, which then reads it no more (kept.svelte.ts `missed`), so only the stalled call answers.
  await page.goto("/#/c/new");
  // The For you count comes with the socket's hello.
  await expect(page.locator('a[href="#/c/for-you"][data-unread]')).toBeVisible();
  await page.evaluate(() => { location.hash = "#/c/for-you"; });
  await expect(page.getByText("Loading For you")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("For you did not answer in 10 s.", { timeout: 20_000 });
  stall = false;
  await page.getByRole("button", { name: "Retry For you" }).click();
  await expect(page.getByRole("list", { name: "For you asks" }).locator("li")).toHaveCount(4);
});

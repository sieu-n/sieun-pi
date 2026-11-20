import { expect, test } from "@playwright/test";

/**
 * A switch between roots used to take the old sidebar's nodes out and build the new one's: on 11-20 that was 24 to 66 ms of a 104 to
 * 177 ms switch from a DM to an agent's page. The shell now keeps each sidebar it has shown and hides it, so a switch back shows the
 * same nodes.
 */
test("a sidebar stays mounted behind another root's, and only the one on the screen is the page's sidebar", async ({ page }) => {
  await page.goto("/#/c/ch_cutover");
  const messages = page.locator('nav[data-root="messages"]');
  await expect(messages.locator("[data-sidebar-row]").first()).toBeVisible({ timeout: 20_000 });
  await messages.evaluate((nav) => ((nav as HTMLElement & { kept?: boolean }).kept = true));

  await page.evaluate(() => { location.hash = "#/agents"; });
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-root", "agents");
  await expect(messages).toBeHidden();
  await expect(messages).toHaveCount(1);

  await page.evaluate(() => { location.hash = "#/c/ch_cutover"; });
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-root", "messages");
  await expect(messages).toBeVisible();
  expect(await messages.evaluate((nav) => (nav as HTMLElement & { kept?: boolean }).kept)).toBe(true);
  await expect(page.locator('nav[data-root="agents"]')).toBeHidden();
});

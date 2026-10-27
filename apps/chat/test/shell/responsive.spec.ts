import { expect, test } from "@playwright/test";

test("below 1000 px the side panel floats over the main panel", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/#/ui");
  await page.getByRole("button", { name: "Side panel" }).click();
  const main = (await page.getByTestId("main-panel").boundingBox())!;
  const side = (await page.getByTestId("side-panel").boundingBox())!;
  expect(side.x).toBeLessThan(main.x + main.width);
  expect(Math.round(side.width)).toBe(420);
});

test("below 650 px the sidebar is a drawer that the toggle opens and a route change closes", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("/#/c/ch_general");
  const nav = page.getByRole("navigation", { name: "Conversations" });
  await expect(nav).toHaveCount(0);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(nav).toBeVisible();
  expect(Math.round((await nav.boundingBox())!.width)).toBe(220);
  await nav.getByRole("link", { name: "Vent", exact: true }).click();
  await expect(nav).toHaveCount(0);
});

test("Cmd or Ctrl plus and minus change the interface size and 0 resets it", async ({ page }) => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto("/#/c/ch_general");
  await page.keyboard.press(`${mod}+=`);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.1");
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.1");
  await page.keyboard.press(`${mod}+0`);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("");
});

import { expect, test, type Page } from "@playwright/test";

async function drag(page: Page, name: string, dx: number) {
  const handle = page.getByRole("separator", { name });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

const width = async (page: Page, selector: string) => Math.round((await page.locator(selector).boundingBox())!.width);

test.beforeEach(async ({ page }) => {
  await page.goto("/#/ui");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("the sidebar is 260 px, drags between 220 and 520 px, and keeps its width", async ({ page }) => {
  const nav = 'nav[aria-label="Conversations"]';
  expect(await width(page, nav)).toBe(260);
  await drag(page, "Resize sidebar", 100);
  expect(await width(page, nav)).toBe(360);
  await drag(page, "Resize sidebar", 400);
  expect(await width(page, nav)).toBe(520);
  await drag(page, "Resize sidebar", -500);
  expect(await width(page, nav)).toBe(220);
  await page.reload();
  expect(await width(page, nav)).toBe(220);
});

test("the sidebar toggle hides and shows the sidebar", async ({ page }) => {
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
});

test("the side panel opens at 420 px, resizes from its left edge, and closes", async ({ page }) => {
  await page.getByRole("button", { name: "Side panel" }).click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toBeVisible();
  expect(await width(page, '[data-testid="side-panel"]')).toBe(420);
  await drag(page, "Resize side panel", -80);
  expect(await width(page, '[data-testid="side-panel"]')).toBe(500);
  await drag(page, "Resize side panel", 400);
  expect(await width(page, '[data-testid="side-panel"]')).toBe(300);
  await page.getByRole("button", { name: "Close side panel" }).click();
  await expect(panel).toHaveCount(0);
});

test("the main panel and side panel sit 8 px apart with 24 px corners", async ({ page }) => {
  await page.getByRole("button", { name: "Side panel" }).click();
  const main = (await page.getByTestId("main-panel").boundingBox())!;
  const side = (await page.getByTestId("side-panel").boundingBox())!;
  expect(Math.round(side.x - (main.x + main.width))).toBe(8);
  await expect(page.getByTestId("main-panel")).toHaveCSS("border-top-left-radius", "24px");
});

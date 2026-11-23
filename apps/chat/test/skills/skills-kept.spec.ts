/**
 * Settings > Skills draws its kept answers at once and reads them again behind (pages/skills/kept.svelte.ts). In the p155 rig at the
 * owner's 200 ms round trip on 11-23, every open read GET /api/skills (252 KB as brotli) beside GET /api/skills/inventory and waited for
 * both: 1,094 and 642 ms at p50, 1,471 and 1,410 ms at p90, though the default `current` layout draws only the inventory
 * (~/work/p155-sweep/fix-skills/notes.md).
 */
import { expect, test, type Page } from "@playwright/test";

/** Holds every answer of `path` for `ms` before it goes on. */
async function slow(page: Page, path: string, ms: number): Promise<void> {
  await page.route(url => url.pathname === path, async route => {
    await new Promise(resolve => setTimeout(resolve, ms));
    await route.continue();
  });
}

/** Whether the page stored a skills answer in IndexedDB for the next page load. */
const storedKeys = (page: Page) => page.evaluate(() => new Promise<string[]>(resolve => {
  const open = indexedDB.open("chat.skills", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("answers");
  open.onsuccess = () => {
    const keys = open.result.transaction("answers", "readonly").objectStore("answers").getAllKeys();
    keys.onsuccess = () => {
      open.result.close();
      resolve((keys.result as string[]).sort());
    };
  };
}));

test("the current layout waits on the inventory alone, and the view goes ahead after it", async ({ page }) => {
  const at: Record<string, number> = {};
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/skills") at.view ??= Date.now();
  });
  page.on("requestfinished", request => {
    if (new URL(request.url()).pathname === "/api/skills/inventory") at.inventory ??= Date.now();
  });
  await page.goto("/#/settings/skills");
  await expect(page.getByTestId("skills-summary")).toContainText("skills");
  await expect.poll(() => at.view ?? 0).toBeGreaterThan(0);
  expect(at.view).toBeGreaterThanOrEqual(at.inventory!);
  // The view read ahead is kept, so a switch to a layout that draws it shows it with no wait.
  await expect.poll(() => storedKeys(page)).toEqual(["inventory", "view"]);
  await slow(page, "/api/skills", 4000);
  await page.getByRole("tablist", { name: "Layout", exact: true }).getByRole("tab", { name: "Kinds", exact: true }).click();
  await expect(page.getByTestId("skills-kinds")).toBeVisible({ timeout: 1500 });
});

test("a second open and a page load draw the kept inventory while its read is on its way", async ({ page }) => {
  await page.goto("/#/settings/skills");
  await expect(page.getByTestId("skills-summary")).toContainText("skills");
  await expect.poll(() => storedKeys(page)).toContain("inventory");
  await slow(page, "/api/skills/inventory", 4000);
  await page.goto("/#/settings/keyboard");
  // The refresh asks for the changes since the version the page holds, and an unchanged inventory answers `same`.
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/skills/inventory", { timeout: 10_000 });
  await page.goto("/#/settings/skills");
  await expect(page.getByTestId("skills-summary")).toContainText("skills", { timeout: 1500 });
  const answer = await refresh;
  expect(new URL(answer.url()).searchParams.get("since")).toMatch(/^[\w-]{20,}$/);
  expect(await answer.json()).toMatchObject({ same: true });
  await page.reload();
  await expect(page.getByTestId("skills-summary")).toContainText("skills", { timeout: 2500 });
});

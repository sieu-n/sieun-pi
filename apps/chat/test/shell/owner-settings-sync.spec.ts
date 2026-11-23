import { expect, test, type Page } from "@playwright/test";
import { tag } from "../channel/helpers";
import { ownerSettings, resetOwnerSettings } from "./owner-settings";

/**
 * The owner's status, notification setting and recent searches are the same in every browser (lib/owner-settings.svelte.ts): a change in
 * one page shows in another at once, and a browser's old localStorage copies move to the server on its first load and leave it.
 */

// The settings live on the one fixture server, so these tests take turns and leave them at the default.
test.describe.configure({ mode: "serial" });
test.beforeEach(({ request }) => resetOwnerSettings(request));
test.afterAll(({ request }) => resetOwnerSettings(request));

const mod = process.platform === "darwin" ? "Meta" : "Control";
const profile = (page: Page) => page.locator("header.topbar button.profile");
const recent = (page: Page) => page.locator("[data-search-palette] [role=group][aria-label='Recent searches'] [data-search-result]");

async function openApp(page: Page): Promise<void> {
  await page.goto("/#/c/saved");
  await expect(profile(page)).toBeVisible({ timeout: 20_000 });
}

test("away, a status, a pause and a search set in one browser show in another without a reload", async ({ page, browser }) => {
  const other = await browser.newContext();
  const second = await other.newPage();
  try {
    await openApp(page);
    await openApp(second);

    await profile(page).click();
    await page.getByRole("menu", { name: "Profile" }).getByRole("menuitem", { name: "Set yourself as away" }).click();
    await expect(profile(second)).toHaveAttribute("aria-label", /away/);

    await profile(page).click();
    await page.getByRole("menu", { name: "Profile" }).getByRole("menuitem", { name: "Set a status" }).click();
    const dialog = page.getByRole("dialog", { name: "Set a status" });
    await dialog.getByRole("button", { name: /Out sick/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(profile(second)).toHaveAttribute("aria-label", /🤒 Out sick/);

    await second.goto("/#/settings/notifications");
    await second.getByLabel("Notify me about").selectOption("all");
    await expect.poll(async () => (await ownerSettings(page.request)).notify.level).toBe("all");
    await page.goto("/#/settings/notifications");
    await expect(page.getByLabel("Notify me about")).toHaveValue("all");
    await page.getByLabel("Notify me about").selectOption("off");
    await expect(second.getByLabel("Notify me about")).toHaveValue("off");

    const word = `relay${tag()}`;
    await page.goto(`/#/search?q=${word}`);
    await expect(page.locator("[data-search-page]")).toBeVisible();
    await second.goto("/#/c/ch_general");
    await second.keyboard.press(`${mod}+k`);
    await expect(recent(second).first()).toHaveText(word);
  } finally {
    await other.close();
  }
});

test("after a change and a restore, a browser's old localStorage copies still move up once and leave localStorage", async ({ page }) => {
  const t = tag();
  const [canary, relay] = [{ q: `canary${t}`, filters: {} }, { q: `relay${t}`, filters: { from: "vent" } }];
  await page.request.patch("/api/owner-settings", { data: { recentSearches: [canary] } });
  // A walk's round trip: read, change, put the read copy back with its stamps.
  const before = await ownerSettings(page.request);
  await page.request.patch("/api/owner-settings", { data: { presence: { away: true }, notify: { level: "all", badge: true } } });
  await page.request.put("/api/owner-settings", { data: before });
  expect((await ownerSettings(page.request)).edited.presence).toBeUndefined();

  await openApp(page);
  await page.evaluate((old) => {
    localStorage.setItem("chat.presence", JSON.stringify({ away: true, status: { emoji: "🎧", text: "Focus" } }));
    localStorage.setItem("chat.notify", JSON.stringify({ level: "off", badge: false }));
    localStorage.setItem("chat.recentSearches", JSON.stringify(old));
  }, [relay, canary]);
  await page.reload();
  await expect(profile(page)).toHaveAttribute("aria-label", /away, 🎧 Focus/);
  const saved = await ownerSettings(page.request);
  expect(saved.presence).toEqual({ away: true, status: { emoji: "🎧", text: "Focus" } });
  expect(saved.notify).toEqual({ level: "off", badge: false });
  // Other specs' searches may land in the list meanwhile, so this looks at its own two.
  expect((saved.recentSearches as { q: string }[]).filter(one => one.q.endsWith(t))).toEqual([canary, relay]);
  expect(await page.evaluate(() => ["chat.presence", "chat.notify", "chat.recentSearches"].map(key => localStorage.getItem(key)))).toEqual([null, null, null]);
});

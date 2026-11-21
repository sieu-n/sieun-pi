import { expect, test, type Page } from "@playwright/test";

/** Slack's navigation keys: Alt+Up and Alt+Down walk the Messages sidebar, Alt+Shift jumps to unread rows, and Cmd+/ lists every key. */

const rows = (page: Page) => page.locator('nav[data-root="messages"] [data-sidebar-row]');
const hash = (page: Page) => page.evaluate(() => location.hash);

async function sidebarHrefs(page: Page): Promise<{ href: string; unread: boolean }[]> {
  return rows(page).evaluateAll((links) => links.map((a) => ({ href: a.getAttribute("href") ?? "", unread: a.hasAttribute("data-unread") })));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/later");
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
});

test("Alt+Down and Alt+Up step through the sidebar rows in the order they are drawn", async ({ page }) => {
  const hrefs = (await sidebarHrefs(page)).map((r) => r.href);
  expect(hrefs.length).toBeGreaterThan(3);
  expect(hrefs[0]).toBe("#/c/later");
  for (const href of hrefs.slice(1)) {
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => hash(page)).toBe(href);
  }
  await page.keyboard.press("Alt+ArrowDown");
  expect(await hash(page)).toBe(hrefs.at(-1));
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => hash(page)).toBe(hrefs.at(-2));
});

test("Alt+Down works from the message box", async ({ page }) => {
  const hrefs = (await sidebarHrefs(page)).map((r) => r.href);
  const channel = hrefs.find((h) => h.startsWith("#/c/ch_"))!;
  await page.goto(`/${channel}`);
  await page.locator('[data-testid="composer"] [contenteditable="true"]').first().focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => hash(page)).toBe(hrefs[hrefs.indexOf(channel) + 1]);
});

test("Alt+Shift+Down jumps to the next unread conversation, or says there is none", async ({ page }) => {
  const list = await sidebarHrefs(page);
  const unread = list.filter((r) => r.unread && /^#\/c\/[a-z]+_/.test(r.href));
  await page.keyboard.press("Alt+Shift+ArrowDown");
  if (unread.length) await expect.poll(() => hash(page)).toBe(unread[0]!.href);
  else await expect(page.getByText("No unread conversations")).toBeVisible();
});

test("Cmd+/ opens the shortcuts sheet, and Esc closes it", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-shortcut="next-unread"]')).toContainText("Next unread conversation");
  await expect(sheet.locator('[data-shortcut="mark-unread"]')).toContainText("on a focused or hovered message");
  await page.keyboard.press("Alt+ArrowDown");
  expect(await hash(page)).toBe("#/c/later");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("Cmd+Shift+D hides and shows the sidebar, and its button names the key", async ({ page }) => {
  const nav = page.locator('nav[data-root="messages"]');
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await expect(nav).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await expect(nav).toBeVisible();
  await page.getByRole("button", { name: "Hide sidebar" }).hover();
  await expect(page.locator(".ui-tooltip")).toContainText(/Shift\s*D|⇧D/);
});

test("Cmd+2, Cmd+3, Cmd+1, Cmd+comma, Cmd+Shift+K, Cmd+Shift+M and Cmd+Shift+S open their pages", async ({ page }) => {
  const cases: [string, RegExp][] = [
    ["ControlOrMeta+2", /^#\/agents/],
    ["ControlOrMeta+3", /^#\/board/],
    ["ControlOrMeta+1", /^#\/c\/later/],
    ["ControlOrMeta+,", /^#\/settings/],
    ["ControlOrMeta+Shift+K", /^#\/c\/new\?kind=dm/],
    ["ControlOrMeta+Shift+M", /^#\/c\/for-you/],
    ["ControlOrMeta+Shift+S", /^#\/c\/later/],
  ];
  for (const [keys, want] of cases) {
    await page.keyboard.press(keys);
    await expect.poll(() => hash(page), { message: keys }).toMatch(want);
  }
});

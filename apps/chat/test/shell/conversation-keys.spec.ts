import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Slack's navigation keys: Alt+Up and Alt+Down walk the Messages sidebar, Alt+Shift jumps to unread rows, and Cmd+/ lists every key. */

const rows = (page: Page) => page.locator('nav[data-root="messages"] [data-sidebar-row]');
const hash = (page: Page) => page.evaluate(() => location.hash);

async function sidebarHrefs(page: Page): Promise<{ href: string; unread: boolean }[]> {
  return rows(page).evaluateAll((links) => links.map((a) => ({ href: a.getAttribute("href") ?? "", unread: a.hasAttribute("data-unread") })));
}

/** The address, the sidebar row drawn as the open one and the drawn sidebar rows, read in one call. */
async function drawn(page: Page): Promise<{ at: string; selected: string | null; hrefs: string[] }> {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('nav[data-root="messages"] [data-sidebar-row]')];
    return {
      at: location.hash,
      selected: links.find((a) => a.getAttribute("aria-current") === "page")?.getAttribute("href") ?? null,
      hrefs: links.map((a) => a.getAttribute("href") ?? ""),
    };
  });
}

/**
 * Presses Alt+Down or Alt+Up and checks that the page moved to the row drawn next to the open one. Other specs add, close and archive rooms
 * on the one fixture server while a walk runs, so the row counts as next in the rows drawn just before the key or just after the move.
 * Returns false, with no key pressed, when the open row is the last drawn one in that direction.
 */
async function step(page: Page, by: 1 | -1): Promise<boolean> {
  const before = await drawn(page);
  const target = before.hrefs[before.hrefs.indexOf(before.at) + by];
  if (!target) return false;
  await page.keyboard.press(by === 1 ? "Alt+ArrowDown" : "Alt+ArrowUp");
  await expect.poll(async () => {
    const now = await drawn(page);
    if (now.at === before.at) return `still on ${before.at}`;
    // The next key goes from the row the sidebar shows as open, which follows the address a moment later.
    if (now.selected !== now.at) return `${now.at} is open, and the sidebar still shows ${now.selected} as open`;
    return now.at === target || now.hrefs[now.hrefs.indexOf(now.at) - by] === before.at ? "next row" : `${now.at}, where the row after ${before.at} was ${target}`;
  }).toBe("next row");
  return true;
}

/** The first unread conversation drawn after the open row, wrapping around the ends, as Alt+Shift+Down picks it. */
async function nextUnreadTarget(page: Page): Promise<string | undefined> {
  const list = await sidebarHrefs(page);
  const at = list.map((r) => r.href).indexOf(await hash(page));
  return [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0))].find((r) => r.unread && /^#\/c\/[a-z]+_/.test(r.href))?.href;
}

/** A closed Solo room of this test's own, which Vent's answer makes unread, so it sits unread in the Done fold. */
async function closedUnreadSolo(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/rooms", { data: { kind: "solo", agenda: `keys closed ${Date.now()}`, members: ["ag_vent"] } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  expect((await request.patch(`/api/rooms/${id}`, { data: { closed: true } })).ok()).toBe(true);
  await expect.poll(async () => {
    const sidebar = (await (await request.get("/api/sidebar")).json()) as { solo: { id: string; unread: number }[] };
    return sidebar.solo.find((r) => r.id === id)?.unread ?? 0;
  }).toBeGreaterThan(0);
  return id;
}

test.beforeEach(async ({ page }) => {
  // Opening a row marks it read on the one fixture server, and a walk opens every row, so the specs that count on the seeded unread rows
  // would find them read. The page keeps its own read marks; the server keeps the seed's.
  await page.route(/\/api\/c\/[^/]+\/read$/, (route) => (route.request().method() === "POST" ? route.fulfill({ json: { ok: true } }) : route.fallback()));
  await page.goto("/#/c/later");
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
});

test("Alt+Down and Alt+Up step through the sidebar rows in the order they are drawn", async ({ page }) => {
  const hrefs = (await sidebarHrefs(page)).map((r) => r.href);
  expect(hrefs.length).toBeGreaterThan(3);
  expect(hrefs[0]).toBe("#/c/later");
  // The walk opens every row, and other specs keep adding rooms: a full run drew 68 rows, and under its load 24 steps took 26 s.
  test.setTimeout(30_000 + hrefs.length * 1_100);
  while (await step(page, 1));
  const last = await hash(page);
  await page.keyboard.press("Alt+ArrowDown");
  expect(await hash(page)).toBe(last);
  expect(await step(page, -1)).toBe(true);
});

test("Alt+Down works from the message box", async ({ page }) => {
  const channel = (await sidebarHrefs(page)).map((r) => r.href).find((h) => h.startsWith("#/c/ch_"))!;
  await page.goto(`/${channel}`);
  await expect(rows(page).and(page.locator(`[href="${channel}"]`))).toBeVisible();
  await page.locator('[data-testid="composer"] [contenteditable="true"]').first().focus();
  expect(await step(page, 1)).toBe(true);
});

test("Alt+Shift+Down jumps to the next unread conversation drawn, past an unread closed Solo room the Done fold hides", async ({ page, request }) => {
  const closed = await closedUnreadSolo(request);
  try {
    // From the last open Solo row, the Done fold's rooms come next in the sidebar.
    const open = page.locator('nav[data-root="messages"] [data-section="solo"] [data-sidebar-row]:not([data-group="done"] *)');
    await expect(open.first()).toBeVisible();
    await page.goto(`/${await open.last().getAttribute("href")}`);
    await expect(rows(page).first()).toBeVisible();
    const target = await nextUnreadTarget(page);
    await page.keyboard.press("Alt+Shift+ArrowDown");
    if (target) await expect.poll(() => hash(page)).toBe(target);
    else await expect(page.getByText("No unread conversations")).toBeVisible();
    expect(await hash(page)).not.toBe(`#/c/${closed}`);
  } finally {
    await request.patch(`/api/c/${closed}`, { data: { archived: true } });
  }
});

test("Alt+Shift+Down from Later reaches the first unread row drawn, or says there is none", async ({ page }) => {
  const target = await nextUnreadTarget(page);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  if (target) await expect.poll(() => hash(page)).toBe(target);
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

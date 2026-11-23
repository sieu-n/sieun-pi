import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Every floating surface stays inside the window and next to what opened it, at the owner's window (a MacBook Pro 14 browser window),
 * a smaller one, and the interface sizes Cmd + and Cmd - set (CSS zoom on the root, lib/shell/zoom.ts).
 */
const WINDOWS = [
  { width: 1512, height: 900 },
  { width: 1180, height: 720 },
];
const SCALES = [1, 1.2, 0.8];

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

async function inside(page: Page, locator: Locator) {
  await locator.evaluate((el) => Promise.all(el.closest(".popover")?.getAnimations().map((a) => a.finished) ?? []));
  const b = await box(locator);
  const size = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(size.height + 0.5);
  return b;
}

/**
 * A channel of the test's own with a few owner posts, so no other spec's send and no fixture agent's reply lands in it and moves the post out
 * from under the pointer between the hover and the click on its hover bar.
 */
async function channel(page: Page): Promise<{ room: string; post: string }> {
  const name = `popover-${Math.random().toString(36).slice(2, 8)}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const ids: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const sent = await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}: the census for lane ${n} finished`, requestId: crypto.randomUUID() } });
    ids.push(((await sent.json()) as { item: { id: string } }).item.id);
  }
  return { room, post: ids[2]! };
}

async function open(page: Page, scale: number, hash: string) {
  await page.addInitScript((value) => {
    if (value === 1) localStorage.removeItem("chat.interfaceScale");
    else localStorage.setItem("chat.interfaceScale", String(value));
  }, scale);
  await page.goto(hash);
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible({ timeout: 15_000 });
}

for (const size of WINDOWS) {
  for (const scale of SCALES) {
    test.describe(`${size.width}x${size.height} at ${Math.round(scale * 100)}%`, () => {
      test.use({ viewport: size });

      test("a sidebar row's menu opens under its button and Move to opens beside its row", async ({ page }) => {
        await open(page, scale, "/#/c/ch_general");
        const sidebar = page.getByRole("navigation", { name: "Conversations" });
        await sidebar.locator('a[href="#/c/ch_general"]').hover();
        const button = sidebar.getByRole("button", { name: "general options" });
        await button.click();
        const menu = page.getByRole("menu").first();
        const b = await box(button);
        const m = await inside(page, menu);
        const gap = Math.min(Math.abs(m.y - (b.y + b.height)), Math.abs(b.y - (m.y + m.height)));
        expect(gap).toBeLessThan(12 * scale);
        expect(Math.abs(m.x - b.x)).toBeLessThan(2);

        const row = page.getByRole("menuitem", { name: "Move to" });
        await row.hover();
        const sub = page.getByRole("menu").nth(1);
        await expect(sub).toBeVisible();
        const r = await box(row);
        const s = await inside(page, sub);
        const beside = Math.min(Math.abs(s.x - (m.x + m.width)), Math.abs(m.x - (s.x + s.width)));
        expect(beside).toBeLessThan(12 * scale);
        expect(s.y).toBeLessThanOrEqual(r.y + r.height);
        expect(s.y + s.height).toBeGreaterThanOrEqual(r.y);
      });

      test("a right-click menu opens at the pointer", async ({ page }) => {
        await open(page, scale, "/#/c/ch_general");
        const link = page.getByRole("navigation", { name: "Conversations" }).locator('a[href="#/c/ch_general"]');
        const l = await box(link);
        const pointer = { x: l.x + 40, y: l.y + l.height / 2 };
        await page.mouse.click(pointer.x, pointer.y, { button: "right" });
        const m = await inside(page, page.getByRole("menu").first());
        expect(Math.abs(m.x - pointer.x)).toBeLessThan(2);
        // The menu hangs from the pointer when it fits below, and near the bottom edge it flips up so its bottom sits at the pointer, as
        // Slack's does: at 1180x720 and 100% the channel row's menu is 315 px tall under a pointer 302 px from the bottom.
        const fitsBelow = pointer.y + m.height <= page.viewportSize()!.height - 8 * scale;
        expect(Math.abs((fitsBelow ? m.y : m.y + m.height) - pointer.y)).toBeLessThan(2);
      });

      test("the emoji picker and the profile menu stay in the window", async ({ page }) => {
        const { room, post: id } = await channel(page);
        await open(page, scale, `/#/c/${room}`);
        const post = page.locator(`section.conversation [data-message-id="${id}"]`);
        await post.hover();
        await post.getByRole("toolbar", { name: "Message actions" }).getByRole("button", { name: "Add reaction" }).click();
        const picker = page.locator("[data-emoji-picker]");
        await expect(picker).toBeVisible();
        const p = await inside(page, picker);
        expect(p.height).toBeGreaterThan(200);
        await page.keyboard.press("Escape");
        await expect(picker).toHaveCount(0);

        await page.getByRole("button", { name: /^Profile/ }).click();
        await inside(page, page.getByRole("menu", { name: "Profile" }));
      });
    });
  }
}

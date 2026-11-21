import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers.ts";

/**
 * A due reminder as Slack's Slackbot message has it: the toast carries View, Mark complete and a Snooze menu (lib/remind-live.ts). Undo
 * after Remove from Later puts the row back with its reminder (server/later.ts `restore`), and a post kept unread reads as coming back
 * unread, never as a reminder he set. Each run makes its own channel on the fixture server.
 */
async function post(page: Page): Promise<{ room: string; id: string; text: string }> {
  const name = `remind-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const text = `remind me about ${name}`;
  const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
  return { room, id: sent.item.id, text };
}

type Item = { id: string; state: string; remindAt?: number; unread?: boolean };
const item = async (page: Page, id: string): Promise<Item | undefined> =>
  ((await (await page.request.get("/api/later")).json()) as { items: Item[] }).items.find((i) => i.id === id);

test("a due reminder's toast snoozes it from a menu and marks it complete", async ({ page }) => {
  const a = await post(page);
  const b = await post(page);
  await open(page, `#/c/${a.room}`);
  const due = Date.now() + 1500;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt: due } });
  await page.request.post("/api/later", { data: { room: b.room, post: b.id, remindAt: due } });

  const toastA = page.locator(".toast").filter({ hasText: a.text });
  await expect(toastA).toBeVisible({ timeout: 10_000 });
  await expect(toastA.getByRole("button")).toHaveText(["View", "Mark complete", "Snooze", ""]);
  await toastA.getByRole("button", { name: "Snooze" }).click();
  const menu = page.getByRole("menu", { name: "Snooze" });
  await expect(menu.getByRole("menuitem")).toHaveText(["In 20 minutes", "In 1 hour", "In 3 hours", "Tomorrow", "Next week"]);
  const before = Date.now();
  await menu.getByRole("menuitem", { name: "In 1 hour" }).click();
  await expect(toastA).toHaveCount(0);
  await expect(page.locator(".toast").filter({ hasText: "We'll remind you at" })).toBeVisible();
  await expect.poll(async () => ((await item(page, `${a.room}:${a.id}`))?.remindAt ?? 0) - before).toBeGreaterThan(3_500_000);

  const toastB = page.locator(".toast").filter({ hasText: b.text });
  await toastB.getByRole("button", { name: "Mark complete" }).click();
  await expect(toastB).toHaveCount(0);
  await expect(page.locator(".toast").filter({ hasText: "Marked complete" })).toBeVisible();
  await expect.poll(async () => (await item(page, `${b.room}:${b.id}`))?.state).toBe("done");
});

test("Undo after Remove from Later brings the row back with its reminder", async ({ page }) => {
  const a = await post(page);
  const remindAt = Date.now() + 2 * 3_600_000;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt } });
  await open(page, "#/c/later", "later-page");
  const row = page.locator(`[data-later-id="${a.room}:${a.id}"]`);
  await expect(row.locator("[data-later-due]")).toContainText("Due");
  await row.hover();
  await row.locator("[data-later-remove]").click();
  await expect(row).toHaveCount(0);
  await page.locator(".toast").filter({ hasText: "Removed from Later" }).getByRole("button", { name: "Undo" }).click();
  await expect(row.locator("[data-later-due]")).toContainText("Due");
  await expect(page.locator(".toast").filter({ hasText: "Saved for later" })).toHaveCount(0);
  expect((await item(page, `${a.room}:${a.id}`))?.remindAt).toBe(remindAt);
});

test("a post kept unread says when it comes back unread, not a due time", async ({ page }) => {
  const a = await post(page);
  await page.request.post(`/api/c/${a.room}/read`, { data: { unreadFrom: a.id } });
  await open(page, "#/c/later", "later-page");
  const row = page.locator(`[data-later-id="${a.room}:${a.id}"]`);
  await expect(row.locator("[data-later-due]")).toContainText("Comes back unread");
  await row.hover();
  await row.locator("[data-later-remind]").click();
  const menu = page.getByRole("menu", { name: "Change when it comes back" });
  await expect(menu.getByRole("menuitem").last()).toHaveText("Don't bring it back");
});

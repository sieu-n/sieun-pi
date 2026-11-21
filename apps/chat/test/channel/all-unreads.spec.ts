import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers.ts";

/**
 * All unreads and Mark all as read, as a Slack user checks them: the All unreads row lists every unread room's new posts in one scroll,
 * each room and the whole list mark read with an Undo in the toast, a section's menu marks its rooms read, and a room opened with new
 * posts shows "N new messages since" with Mark as read, which Esc does too. Each run makes its own channels on the fixture server.
 */
async function channel(page: Page, count: number, unreadFrom: number): Promise<{ room: string; name: string; ids: string[] }> {
  const name = `unreads-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
    ids.push(sent.item.id);
  }
  await page.request.post(`/api/c/${room}/read`, { data: { unreadFrom: ids[unreadFrom - 1] } });
  return { room, name, ids };
}

const sidebarRow = (page: Page, room: string) => page.locator(`[data-sidebar-row][href$="${room}"]`);

test("All unreads lists each unread room's new posts, and Mark as read on one room has an Undo", async ({ page }) => {
  const a = await channel(page, 4, 3);
  const b = await channel(page, 3, 1);
  await page.goto("/#/c");
  await page.getByRole("link", { name: "All unreads" }).click();
  await expect(page.getByTestId("unreads-page")).toBeVisible();
  const sectionA = page.locator(`[data-unread-room="${a.room}"]`);
  const sectionB = page.locator(`[data-unread-room="${b.room}"]`);
  await expect(sectionA.locator("[data-message-id]")).toHaveCount(2);
  await expect(sectionA).toContainText(`post 3 of ${a.name}`);
  await expect(sectionA).not.toContainText(`post 2 of ${a.name}`);
  await expect(sectionA.locator(".room-head")).toContainText("2 new");
  await expect(sectionB.locator("[data-message-id]")).toHaveCount(3);

  await sectionA.getByTestId("unreads-mark-room").click();
  const toast = page.getByRole("status").filter({ hasText: `Marked #${a.name} as read` });
  await expect(toast).toBeVisible();
  await expect(sectionA).toHaveCount(0);
  await expect(sidebarRow(page, a.room)).not.toHaveAttribute("data-unread", "true");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(sectionA.locator("[data-message-id]")).toHaveCount(2);
  await expect(sidebarRow(page, a.room)).toHaveAttribute("data-unread", "true");

  await sectionA.locator(".room-name").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${a.room}$`));
});

test("Mark all as read empties All unreads, and its Undo brings every room back", async ({ page }) => {
  const a = await channel(page, 2, 2);
  await page.goto("/#/c/unreads");
  await expect(page.locator(`[data-unread-room="${a.room}"]`)).toBeVisible();
  await page.getByTestId("unreads-mark-all").click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  const toast = page.getByRole("status").filter({ hasText: /Marked .* as read/ });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(`[data-unread-room="${a.room}"] [data-message-id]`)).toHaveCount(1);
});

test("a section's menu marks only its rooms read", async ({ page }) => {
  const a = await channel(page, 2, 1);
  const b = await channel(page, 2, 1);
  await page.goto(`/#/c`);
  await sidebarRow(page, a.room).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).hover();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  const section = `Sec ${tag()}`;
  await page.getByRole("dialog").getByRole("textbox").fill(section);
  await page.getByRole("dialog").getByRole("textbox").press("Enter");
  await page.getByRole("button", { name: `${section} options` }).click();
  await page.getByRole("menuitem", { name: "Mark all as read" }).click();
  await expect(sidebarRow(page, a.room)).not.toHaveAttribute("data-unread", "true");
  await expect(sidebarRow(page, b.room)).toHaveAttribute("data-unread", "true");
});

test("a room opened with new posts shows the New messages bar, and Mark as read or Esc clears it", async ({ page }) => {
  const a = await channel(page, 30, 21);
  await open(page, `#/c/${a.room}`);
  const bar = page.getByTestId("new-messages-bar");
  await expect(bar).toContainText("10 new messages since");
  await expect(page.getByTestId("new-line")).toHaveCount(1);
  await bar.getByRole("button", { name: "Mark as read" }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("new-line")).toHaveCount(0);
  await expect(sidebarRow(page, a.room)).not.toHaveAttribute("data-unread", "true");

  await page.request.post(`/api/c/${a.room}/read`, { data: { unreadFrom: a.ids[27] } });
  await open(page, `#/c/${a.room}`);
  await expect(bar).toContainText("3 new messages since");
  await page.locator("body").press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(sidebarRow(page, a.room)).not.toHaveAttribute("data-unread", "true");
});

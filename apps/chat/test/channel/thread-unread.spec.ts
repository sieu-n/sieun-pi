import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers.ts";

/**
 * A reply in a thread the owner started makes the channel's sidebar row bold with a dot, as a new post does, in an open section and a folded
 * one, and opening the channel clears it (#sw-factory-build p213, server/group-rooms.ts `summary`). Each run makes its own channel with Vent
 * as its member, whose fixture comm thread answers every post in its thread.
 */
async function channel(page: Page): Promise<{ room: string; name: string }> {
  const name = `threads-${tag()}`;
  const made = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: ["ag_vent"] } })).json()) as { id: string };
  return { room: made.id, name };
}

/** Posts as the owner and waits for Vent's answer in the post's thread. */
async function askInThread(page: Page, room: string, text: string): Promise<void> {
  const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
  await expect.poll(async () => {
    const thread = (await (await page.request.get(`/api/c/${room}/replies/${sent.item.id}`)).json()) as { items: { author: { id: string } }[] };
    return thread.items.some((item) => item.author.id !== "owner");
  }, { timeout: 15_000 }).toBe(true);
}

test("a reply in his thread makes the channel row bold with a dot, in a folded section too, and opening the channel clears it", async ({ page }) => {
  const { room, name } = await channel(page);
  await open(page, "#/c/ch_general");
  const sidebarRow = page.locator(`[data-sidebar-row][href$="${room}"]`);
  await expect(sidebarRow).toBeVisible();
  await expect(sidebarRow).not.toHaveAttribute("data-unread", "true");

  await askInThread(page, room, `is the relay up? ${name}`);
  await expect(sidebarRow).toHaveAttribute("data-unread", "true");
  await expect(sidebarRow).toHaveCSS("font-weight", "500");
  await expect(sidebarRow.locator(".trail .dot")).toBeVisible();

  const section = page.locator("[data-section]").filter({ has: sidebarRow });
  const fold = section.locator("[data-fold]");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  try {
    await expect(sidebarRow, "a folded section keeps the unread row").toBeVisible();
    await expect(sidebarRow).toHaveAttribute("data-unread", "true");
  } finally {
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
  }

  await sidebarRow.click();
  await expect(page.getByTestId("timeline").first()).toBeVisible();
  await expect(sidebarRow).not.toHaveAttribute("data-unread", "true");

  await open(page, "#/c/ch_general");
  await askInThread(page, room, `and the canary? ${name}`);
  await expect(sidebarRow).toHaveAttribute("data-unread", "true");
  await page.goto(`/#/c/${room}`);
  await expect(sidebarRow).not.toHaveAttribute("data-unread", "true");
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});

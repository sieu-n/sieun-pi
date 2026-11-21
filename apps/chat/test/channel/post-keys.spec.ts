import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, open, row, tag } from "./helpers.ts";

/**
 * Slack's message keys (Timeline.svelte postKeys, MessageRow.svelte postKey) and its pane keys (SidePanelHost.svelte): Shift+Tab from the
 * composer focuses the newest post, Up and Down move between posts, E R T A M U and Delete act on the focused or hovered post, and Esc or
 * Cmd+. closes the thread pane. Each run makes its own channel on the fixture server.
 */
async function channel(page: Page, count = 6): Promise<{ room: string; posts: string[] }> {
  const name = `keys-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const posts: string[] = [];
  for (let n = 1; n <= count; n++) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
    posts.push(sent.item.id);
  }
  return { room, posts };
}

const focusedPost = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.messageId ?? null);

test("Shift+Tab from the composer focuses the newest post, Up and Down move, and E, Delete and T act on the focused post", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusedPost(page)).toBe(posts[5]);
  await expect(row(page, posts[5]!).getByRole("toolbar", { name: "Message actions" })).toBeVisible();

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedPost(page)).toBe(posts[3]);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedPost(page)).toBe(posts[4]);

  await page.keyboard.press("e");
  await expect(row(page, posts[4]!).getByRole("textbox", { name: "Edit message" })).toBeFocused();
  await page.keyboard.press("Escape");

  await row(page, posts[4]!).focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog").filter({ hasText: "Delete message" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);

  await row(page, posts[4]!).focus();
  await page.keyboard.press("t");
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toHaveAttribute("data-thread", posts[4]!);

  // Shift+Tab goes back to the post focused last, not the newest.
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusedPost(page)).toBe(posts[4]);
});

test("A saves the hovered post for later, M opens Remind me, U marks it unread, and the tooltip names A", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  // The room opens with the composer focused, where A and M type letters as in Slack, so the keys start once focus leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const post = row(page, posts[2]!);
  await post.hover();
  await page.keyboard.press("a");
  await expect(post.locator("[data-saved-label]")).toContainText("Saved for later");

  await post.locator("[data-save-later]").hover();
  await expect(page.locator("[role=tooltip]").filter({ hasText: "Remove from Later" }).locator("kbd")).toHaveText("A");

  await post.hover({ position: { x: 60, y: 10 } });
  await page.keyboard.press("m");
  const menu = page.getByRole("menu", { name: "Remind me about this" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "In 20 minutes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "We'll remind you" })).toBeVisible();
  await expect(post.locator("[data-saved-due]")).toBeVisible();

  const other = row(page, posts[1]!);
  await other.hover({ position: { x: 60, y: 10 } });
  await page.keyboard.press("u");
  await expect(page.getByTestId("new-line")).toHaveCount(1);

  const later = async () => ((await (await page.request.get("/api/later")).json()) as { items: { id: string; remindAt?: number; unread?: boolean }[] }).items;
  expect((await later()).find((i) => i.id === `${room}:${posts[2]}`)?.remindAt).toBeGreaterThan(Date.now());
  await expect.poll(async () => (await later()).find((i) => i.id === `${room}:${posts[1]}`)?.unread).toBe(true);
});

test("Esc and Cmd+. close the thread pane, and Esc in a reply with text keeps it", async ({ page }) => {
  const { room, posts } = await channel(page, 3);
  await open(page, `#/c/${room}`);
  const pane = page.getByTestId("thread-pane");
  const openThread = async () => {
    await row(page, posts[1]!).hover();
    await row(page, posts[1]!).getByRole("button", { name: "Reply in thread" }).click();
    await expect(pane).toBeVisible();
  };

  await openThread();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);

  await openThread();
  const reply = composerInput(pane);
  await reply.focus();
  await page.keyboard.type("half a reply");
  await page.keyboard.press("Escape");
  await expect(pane).toBeVisible();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(pane).toHaveCount(0);
  await expect(composerInput(conversation(page))).toBeFocused();

  await openThread();
  await composerInput(pane).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
});

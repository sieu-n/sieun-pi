import { expect, test, type Page } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * Slack's Pin to channel: More actions pins a post, the post shows "Pinned by you", the header's Pinned button lists it and jumps to it,
 * and an un-pin from the list carries Undo in its toast. Each run makes its own channel on the fixture server.
 */
async function channel(page: Page): Promise<{ room: string; posts: string[] }> {
  const name = `pins-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const posts: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const sent = await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}: the deploy checklist for lane ${n}`, requestId: crypto.randomUUID() } });
    posts.push(((await sent.json()) as { item: { id: string } }).item.id);
  }
  return { room, posts };
}

test("an empty room's Pinned list shows one card that says how to pin", async ({ page }) => {
  const { room } = await channel(page);
  await open(page, `#/c/${room}`);
  await page.getByTestId("pins-button").click();
  const list = page.getByTestId("pins-list");
  await expect(list.getByText("Nothing pinned yet")).toBeVisible();
  await expect(page.getByTestId("pins-count")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
});

test("More actions pins a post, the header lists it, and an un-pin from the list takes Undo", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const post = row(page, posts[0]!);
  await post.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await post.hover();
  await post.locator("[data-message-menu]").click();
  await page.getByRole("menuitem", { name: "Pin to channel" }).click();
  await expect(post.locator("[data-pinned-label]")).toHaveText("Pinned by you");
  await expect(page.getByTestId("pins-count")).toHaveText("1");

  await post.hover();
  await post.locator("[data-message-menu]").click();
  await expect(page.getByRole("menuitem", { name: "Un-pin from channel" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("pins-button").click();
  const item = page.getByTestId("pins-list").locator(`[data-pin="${posts[0]}"]`);
  await expect(item).toContainText(`post 1 of`);
  await expect(item).toContainText("Pinned by you");
  await item.hover();
  await item.locator("[data-unpin]").click();
  await expect(page.getByTestId("pins-list").getByText("Nothing pinned yet")).toBeVisible();
  await expect(post.locator("[data-pinned-label]")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(post.locator("[data-pinned-label]")).toHaveText("Pinned by you");
  await expect(page.getByTestId("pins-count")).toHaveText("1");
});

test("a pick in the Pinned list jumps to the post", async ({ page }) => {
  const { room, posts } = await channel(page);
  await page.request.post(`/api/c/${room}/posts/${posts[1]}/pin`, { data: { pinned: true } });
  await open(page, `#/c/${room}`);
  await page.getByTestId("pins-button").click();
  await page.getByTestId("pins-list").locator(`[data-pin="${posts[1]}"] button`).first().click();
  await expect(page).toHaveURL(new RegExp(`m=${posts[1]}`));
  await expect(page.getByTestId("pins-list")).toBeHidden();
  await expect(row(page, posts[1]!)).toBeInViewport();
});

test("P on a hovered post pins it and pressed again un-pins it, as in Slack", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const post = row(page, posts[2]!);
  await post.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await post.hover();
  await page.keyboard.press("p");
  await expect(post.locator("[data-pinned-label]")).toHaveText("Pinned by you");
  await page.keyboard.press("p");
  await expect(post.locator("[data-pinned-label]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});

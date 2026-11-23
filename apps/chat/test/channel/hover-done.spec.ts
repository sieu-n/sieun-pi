import { expect, test, type Locator, type Page } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * The hover bar's Mark as done on a thread's root, which the owner asked for on 11-24 in #sw-factory-build (p184): "also hover item 중에 mark
 * as done 둬". It marks the thread done through the owner's route (server/thread-done.ts), then reads Reopen thread, and his reply reopens it.
 * Each run makes its own channel on the fixture server.
 */
async function thread(page: Page): Promise<{ room: string; root: string; reply: string; send: (text: string, threadRoot?: string) => Promise<string> }> {
  const name = `hover-done-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const send = async (text: string, threadRoot?: string) =>
    ((await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID(), threadRoot } })).json()) as { item: { id: string } }).item.id;
  const root = await send(`root of ${name}, is the deploy through?`);
  const reply = await send(`first reply in ${name}`, root);
  return { room, root, reply, send };
}

const toggle = (post: Locator) => post.getByRole("toolbar", { name: "Message actions" }).locator("[data-thread-done-toggle]");

test("Mark as done on a root's hover bar marks the thread done, reads Reopen thread, and reopens it", async ({ page }) => {
  const { room, root } = await thread(page);
  await open(page, `#/c/${room}`);
  const post = row(page, root);
  await post.hover();
  await expect(toggle(post)).toHaveAccessibleName("Mark as done");
  await expect(toggle(post)).toHaveAttribute("aria-pressed", "false");
  await toggle(post).click();
  await expect(post.locator("[data-thread-done]")).toBeVisible();
  await post.hover();
  await expect(toggle(post)).toHaveAccessibleName("Reopen thread");
  await expect(toggle(post)).toHaveAttribute("aria-pressed", "true");
  await toggle(post).click();
  await expect(post.locator("[data-thread-done]")).toHaveCount(0);
  await post.hover();
  await expect(toggle(post)).toHaveAccessibleName("Mark as done");
});

test("the thread pane's root takes Mark as done and a reply does not, and the owner's reply reopens a done thread", async ({ page }) => {
  const { room, root, reply, send } = await thread(page);
  await open(page, `#/c/${room}`);
  const feedRoot = row(page, root).first();
  await feedRoot.locator("[data-thread-pill]").click();
  const paneRoot = page.locator(`[data-message-id="${root}"]`).last();
  const paneReply = page.locator(`[data-message-id="${reply}"]`).last();
  await expect(paneReply).toBeVisible();
  await paneReply.hover();
  await expect(paneReply.locator("[data-message-menu]")).toBeVisible();
  await expect(toggle(paneReply)).toHaveCount(0);
  await paneRoot.hover();
  await toggle(paneRoot).click();
  await expect(feedRoot.locator("[data-thread-done]")).toBeVisible();
  await send("one more thing on this", root);
  await expect(feedRoot.locator("[data-thread-done]")).toHaveCount(0);
  await feedRoot.hover();
  await expect(toggle(feedRoot)).toHaveAccessibleName("Mark as done");
});

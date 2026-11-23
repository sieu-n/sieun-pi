import { expect, test, type Locator, type Page } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * The message hover bar holds Slack's few buttons, sits in the gap above the post so its first line stays readable, drops the quick
 * reactions in the narrow thread pane, and keeps every other action in More actions. Each run makes its own channel on the fixture server.
 */
async function channel(page: Page): Promise<{ room: string; posts: string[]; root: string; replies: string[] }> {
  const name = `hover-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const send = async (text: string, threadRoot?: string) =>
    ((await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID(), threadRoot } })).json()) as { item: { id: string } }).item.id;
  const long = "and every row lines up with the export the owner checked this morning, so nothing is left to fix in the lane.";
  const posts: string[] = [];
  for (let n = 1; n <= 4; n++) posts.push(await send(`post ${n} of ${name}: the census for lane ${n} finished ${long}`));
  const root = await send(`root of ${name}, can someone check the deploy?`);
  const replies = [await send(`first reply ${long}`, root), await send(`second reply ${long}`, root)];
  return { room, posts, root, replies };
}

/** The bar's box against the first line of the post's text, which it must not cover. */
async function geometry(post: Locator) {
  const bar = await post.getByRole("toolbar", { name: "Message actions" }).boundingBox();
  const text = await post.locator(".msg-text").first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const first = range.getClientRects()[0]!;
    return { top: first.top, bottom: first.bottom };
  });
  return { bar: bar!, text };
}

const buttons = (post: Locator) => post.getByRole("toolbar", { name: "Message actions" }).getByRole("button");
/** The bar's button names; Forward message belongs to the forward spec, so these checks leave it out. */
const labels = (post: Locator) => buttons(post).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")).filter((l) => l !== "Forward message"));

test("a room post's bar holds Slack's seven buttons and Mark as done, and sits above the post's first line", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const post = row(page, posts[2]!);
  await post.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await post.hover();
  await expect(post.locator("[data-quick-reaction]")).toHaveCount(3);
  expect((await labels(post)).slice(3)).toEqual(["Add reaction", "Reply in thread", "Save", "Mark as done", "More actions"]);
  const { bar, text } = await geometry(post);
  expect(bar.y + bar.height).toBeLessThanOrEqual(text.top + 1);
});

test("More actions holds the rest, and Edit message from it opens the editor with focus", async ({ page }) => {
  const { room, posts } = await channel(page);
  await open(page, `#/c/${room}`);
  const post = row(page, posts[1]!);
  await post.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await post.hover();
  await post.locator("[data-message-menu]").click();
  const items = page.getByRole("menu", { name: "Message actions" }).getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  const names = (await items.allTextContents()).map((t) => t.trim());
  const mine = ["Mark unread", "Remind me about this", "Copy link", "Copy text", "Edit message", "Delete message"];
  expect(names.filter((t) => mine.some((m) => t.startsWith(m)))).toEqual(mine.map((m) => expect.stringMatching(new RegExp(`^${m}`))));
  await page.getByRole("menuitem", { name: "Edit message" }).click();
  const box = post.getByRole("textbox", { name: "Edit message" });
  await expect(box).toBeFocused();
  await box.press("Escape");
});

test("a thread reply's bar in the narrow pane keeps Add reaction, Save and More, off the reply's first line", async ({ page }) => {
  const { room, root, replies } = await channel(page);
  await open(page, `#/c/${room}`);
  await row(page, root).locator("[data-thread-pill]").click();
  const reply = page.locator(`[data-message-id="${replies[1]}"]`).last();
  await expect(reply).toBeVisible();
  await reply.hover();
  await expect(reply.locator("[data-message-menu]")).toBeVisible();
  expect(await labels(reply)).toEqual(["Add reaction", "Save", "More actions"]);
  const { bar, text } = await geometry(reply);
  expect(bar.y + bar.height).toBeLessThanOrEqual(text.top + 1);
});

test("a post at the top edge of the timeline keeps its whole bar in view", async ({ page }) => {
  const { room, posts } = await channel(page);
  await page.setViewportSize({ width: 1440, height: 420 });
  await open(page, `#/c/${room}`);
  const post = row(page, posts[1]!);
  const feed = page.getByTestId("timeline").first();
  await post.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await post.hover();
  const bar = (await post.getByRole("toolbar", { name: "Message actions" }).boundingBox())!;
  const top = await feed.evaluate((el) => el.getBoundingClientRect().top);
  expect(bar.y).toBeGreaterThanOrEqual(top);
});

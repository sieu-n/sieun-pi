import { expect, test } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";
import type { Locator } from "@playwright/test";

/** Slack's Edit message and Delete message on the owner's own posts, and the line breaks and :emoji: names a post keeps, in a fixture channel. */
const ROOM = "ch_cutover";
// On 11-03 at a box load of 326 these took 18 to 33 s each against the 30 s default, while the fixture agents streamed their replies.
test.describe.configure({ timeout: 60_000 });

/** Hovers the row and picks an item of its More actions menu; a fixture reply that scrolls the timeline mid-way makes it hover again. */
async function action(post: Locator, item: string, opened: Locator): Promise<void> {
  const page = post.page();
  await expect(async () => {
    if (await opened.isVisible()) return;
    await page.keyboard.press("Escape");
    await post.hover();
    await post.locator("[data-message-menu]").click({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: item }).click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(opened).toBeVisible();
}

async function post(request: import("@playwright/test").APIRequestContext, text: string, room = ROOM): Promise<string> {
  const response = await request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } });
  return ((await response.json()) as { item: { id: string } }).item.id;
}

test("the owner edits his own DM post in place, Enter saves it, and it shows (edited)", async ({ page, request }) => {
  const word = tag();
  const id = await post(request, `draft ${word}`, "dm_vent");
  await open(page, "#/c/dm_vent");
  const mine = row(page, id);
  await action(mine, "Edit message", mine.locator("[data-post-editor]"));
  const box = mine.getByRole("textbox", { name: "Edit message" });
  await expect(box).toHaveValue(`draft ${word}`);
  await box.fill(`final ${word}\nsecond line :eyes:`);
  await box.press("Enter");
  await expect(mine.locator("[data-post-editor]")).toHaveCount(0, { timeout: 15_000 });
  await expect(mine.locator(".msg-text")).toContainText(`final ${word}`);
  await expect(mine.locator(".msg-text br")).toHaveCount(1);
  await expect(mine.locator(".msg-text .emoji")).toHaveText("👀");
  await expect.poll(() => mine.locator(".msg-text p").last().evaluate((el) => getComputedStyle(el, "::after").content)).toBe('" (edited)"');
  await expect.poll(async () => {
    const page_ = (await (await request.get(`/api/c/dm_vent/items?around=${id}`)).json()) as { items: { id: string; text: string }[] };
    return page_.items.find((i) => i.id === id)?.text;
  }).toBe(`final ${word}\nsecond line :eyes:`);
  await page.reload();
  await expect(row(page, id).locator(".msg-text")).toContainText(`final ${word}`);
});

test("the Up arrow in an empty composer opens the owner's last post in its editor, as in Slack", async ({ page, request }) => {
  const word = tag();
  // Its own room: other specs post into the shared fixture channels, and their posts become the owner's last post there.
  const room = ((await (await request.post("/api/rooms", { data: { kind: "channel", name: `up-edit-${word}`, members: [], test: true } })).json()) as { id: string }).id;
  await post(request, `older ${word}`, room);
  const id = await post(request, `newest ${word}`, room);
  await open(page, `#/c/${room}`);
  const box = page.getByTestId("composer-input").first();
  await box.click();
  await box.press("ArrowUp");
  const editor = row(page, id).getByRole("textbox", { name: "Edit message" });
  await expect(editor).toHaveValue(`newest ${word}`, { timeout: 15_000 });
  await editor.press("Escape");
  await box.fill("not empty");
  await box.press("ArrowUp");
  await expect(page.locator("[data-post-editor]")).toHaveCount(0);
});

test("Escape cancels an edit and keeps the post as it was", async ({ page, request }) => {
  const word = tag();
  const id = await post(request, `keep ${word}`);
  await open(page, `#/c/${ROOM}`);
  const mine = row(page, id);
  await action(mine, "Edit message", mine.locator("[data-post-editor]"));
  await mine.getByRole("textbox", { name: "Edit message" }).fill("changed");
  await mine.getByRole("textbox", { name: "Edit message" }).press("Escape");
  await expect(mine.locator(".msg-text")).toHaveText(`keep ${word}`);
  await expect(mine.locator("[data-edited]")).toHaveCount(0);
});

test("a deleted channel post with replies stays as a stub over its thread, as in Slack", async ({ page, request }) => {
  const id = await post(request, `wrong room ${tag()}`);
  await request.post(`/api/c/${ROOM}/send`, { data: { text: "a reply that keeps the thread", requestId: crypto.randomUUID(), threadRoot: id } });
  await open(page, `#/c/${ROOM}`);
  await action(row(page, id), "Delete message", page.locator("[data-confirm-delete]"));
  await page.locator("[data-confirm-delete]").click();
  await expect(row(page, id).locator("[data-deleted]")).toHaveText("This message was deleted.", { timeout: 15_000 });
  await expect(row(page, id).locator("[data-thread-pill]")).toBeVisible();
  await row(page, id).hover();
  await row(page, id).locator("[data-message-menu]").click();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Edit message|Delete message/ })).toHaveCount(0);
});

test("a deleted DM post leaves the conversation", async ({ page, request }) => {
  const response = await request.post("/api/c/dm_vent/send", { data: { text: `oops ${tag()}`, requestId: crypto.randomUUID() } });
  const id = ((await response.json()) as { item: { id: string } }).item.id;
  await open(page, "#/c/dm_vent");
  await action(row(page, id), "Delete message", page.locator("[data-confirm-delete]"));
  await page.locator("[data-confirm-delete]").click();
  await expect(row(page, id)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("timeline").first()).toBeVisible();
  await expect(row(page, id)).toHaveCount(0);
});

test("an agent's post has no Edit or Delete", async ({ page, request }) => {
  // A test agent's own DM: in the shared Vent DM other specs' sends stream new replies that move the rows mid-hover.
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `no edit ${tag()}`, test: true } })).json()) as { room: string };
  await post(request, `hello ${tag()}`, agent.room);
  // The fixture agent answers a plain send with two posts; the second came 2.2 s after the send on 11-23 at a box load near 300.
  let theirs = "";
  await expect.poll(async () => {
    const items = ((await (await request.get(`/api/c/${agent.room}/items`)).json()) as { items: { id: string; kind: string; author: { kind: string } }[] }).items;
    const replies = items.filter((i) => i.kind === "message" && i.author.kind !== "owner");
    theirs = replies.length >= 2 ? replies.at(-1)!.id : "";
    return theirs;
  }, { timeout: 15_000 }).toBeTruthy();
  await open(page, `#/c/${agent.room}`);
  await row(page, theirs).hover();
  await expect(row(page, theirs).locator("[data-quick-reaction]").first()).toBeVisible();
  await row(page, theirs).locator("[data-message-menu]").click();
  await expect(page.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Edit message|Delete message/ })).toHaveCount(0);
});

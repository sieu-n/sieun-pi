import { expect, test } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";
import type { Locator } from "@playwright/test";

/** Slack's Edit message and Delete message on the owner's own posts, and the line breaks and :emoji: names a post keeps, in a fixture channel. */
const ROOM = "ch_cutover";
// On 11-03 at a box load of 326 these took 18 to 33 s each against the 30 s default, while the fixture agents streamed their replies.
test.describe.configure({ timeout: 60_000 });

/** Hovers the row and clicks one of its hover-bar buttons; a fixture reply that scrolls the timeline mid-way makes it hover again. */
async function action(post: Locator, button: string, opened: Locator): Promise<void> {
  await expect(async () => {
    if (await opened.isVisible()) return;
    await post.hover();
    await post.locator(button).click({ timeout: 5_000 });
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
  await action(mine, "[data-edit-post]", mine.locator("[data-post-editor]"));
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
  await post(request, `older ${word}`);
  const id = await post(request, `newest ${word}`);
  await open(page, `#/c/${ROOM}`);
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
  await action(mine, "[data-edit-post]", mine.locator("[data-post-editor]"));
  await mine.getByRole("textbox", { name: "Edit message" }).fill("changed");
  await mine.getByRole("textbox", { name: "Edit message" }).press("Escape");
  await expect(mine.locator(".msg-text")).toHaveText(`keep ${word}`);
  await expect(mine.locator("[data-edited]")).toHaveCount(0);
});

test("a deleted channel post with replies stays as a stub over its thread, as in Slack", async ({ page, request }) => {
  const id = await post(request, `wrong room ${tag()}`);
  await request.post(`/api/c/${ROOM}/send`, { data: { text: "a reply that keeps the thread", requestId: crypto.randomUUID(), threadRoot: id } });
  await open(page, `#/c/${ROOM}`);
  await action(row(page, id), "[data-delete-post]", page.locator("[data-confirm-delete]"));
  await page.locator("[data-confirm-delete]").click();
  await expect(row(page, id).locator("[data-deleted]")).toHaveText("This message was deleted.", { timeout: 15_000 });
  await expect(row(page, id).locator("[data-thread-pill]")).toBeVisible();
  await expect(row(page, id).locator("[data-edit-post]")).toHaveCount(0);
});

test("a deleted DM post leaves the conversation", async ({ page, request }) => {
  const response = await request.post("/api/c/dm_vent/send", { data: { text: `oops ${tag()}`, requestId: crypto.randomUUID() } });
  const id = ((await response.json()) as { item: { id: string } }).item.id;
  await open(page, "#/c/dm_vent");
  await action(row(page, id), "[data-delete-post]", page.locator("[data-confirm-delete]"));
  await page.locator("[data-confirm-delete]").click();
  await expect(row(page, id)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("timeline").first()).toBeVisible();
  await expect(row(page, id)).toHaveCount(0);
});

test("an agent's post has no Edit or Delete", async ({ page, request }) => {
  const items = ((await (await request.get("/api/c/dm_vent/items")).json()) as { items: { id: string; kind: string; author: { kind: string } }[] }).items;
  const theirs = items.findLast((i) => i.kind === "message" && i.author.kind !== "owner")!;
  await open(page, "#/c/dm_vent");
  await row(page, theirs.id).hover();
  await expect(row(page, theirs.id).locator("[data-quick-reaction]").first()).toBeVisible();
  await expect(row(page, theirs.id).locator("[data-edit-post], [data-delete-post]")).toHaveCount(0);
});

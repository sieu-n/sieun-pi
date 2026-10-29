import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, row, tag } from "./helpers";

test("a channel shows its name, purpose, members and a waiting post's delivery", async ({ page }) => {
  // The fixture's deliveries settle at once, so the page reads p7 as still waiting for a slot.
  await page.route("**/api/c/ch_cutover/items*", async (route) => {
    const body = (await (await route.fetch()).json()) as { items: { id: string; deliveries?: { state: string; queue?: unknown }[] }[] };
    for (const item of body.items) if (item.id === "p7") for (const d of item.deliveries ?? []) Object.assign(d, { state: "queued", queue: { state: "queued", position: 2, total: 3 } });
    await route.fulfill({ json: body });
  });
  await open(page, "#/c/ch_cutover");
  await expect(page.getByTestId("conversation-title")).toHaveText("pi-cutover");
  await expect(composerInput(conversation(page))).toHaveAttribute("aria-label", "Message #pi-cutover");
  await expect(row(page, "p7")).toContainText("frontend bro was mentioned and waits at place 2 of 3.");
});

test("a mention of the owner is the lime chip and other mentions are grey", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  const self = row(page, "p6").locator(".mention.self");
  await expect(self).toHaveText("@owner");
  expect(await self.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(190, 218, 54)");
  const other = row(page, "p5").locator(".mention").first();
  expect(await other.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(218, 218, 218)");
});

test("a thread pill opens the replies in the side pane, and a reply posts into that thread", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  await row(page, "p1").locator("[data-thread-pill]").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toContainText("Two of five");
  await expect(pane.locator("[data-thread-pill]")).toHaveCount(0);
  const word = tag();
  await composerInput(pane).click();
  await page.keyboard.type(`thread reply ${word}`);
  const sent = page.waitForRequest((r) => r.url().includes("/api/c/ch_cutover/send"));
  await page.keyboard.press("Enter");
  expect(((await sent).postDataJSON() as { threadRoot: string }).threadRoot).toBe("p1");
  await expect(pane.getByText(`thread reply ${word}`)).toBeVisible();
});

test("Reply in thread on the hover bar opens that post's thread", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  const post = row(page, "p4");
  await post.hover();
  await post.getByRole("button", { name: "Reply in thread" }).click();
  await expect(page).toHaveURL(/thread=p4/);
  await expect(page.getByTestId("thread-pane")).toContainText("Canary send key");
});

test("a post shows at once while the server answers, and becomes the post once it does", async ({ page }) => {
  await open(page, "#/c/ch_general");
  await page.route("**/api/c/ch_general/send", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  const word = tag();
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`post ${word}`);
  await page.keyboard.press("Enter");
  await expect(input).toHaveText("");
  const mine = conversation(page).locator(".row.own").filter({ hasText: `post ${word}` });
  await expect(mine).toBeVisible({ timeout: 1_000 });
  await expect(mine).toHaveAttribute("data-message-id", /^r:/);
  await expect(mine).toHaveAttribute("data-message-id", /^p\d+$/, { timeout: 8_000 });
  await expect(mine).toHaveCount(1);
});

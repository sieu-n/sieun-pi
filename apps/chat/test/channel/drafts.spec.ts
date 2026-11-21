import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, tag } from "./helpers";

const sidebarRow = (page: Page, id: string) => page.locator(`a[data-sidebar-row][href="#/c/${id}"]`);
const draftsRow = (page: Page) => page.locator('a[data-sidebar-row][href="#/c/drafts"]');

async function firstChannel(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const sidebar = (await (await request.get("/api/sidebar")).json()) as { channels: { id: string; name: string }[] };
  const channel = sidebar.channels[0];
  if (!channel) throw new Error("the fixture has no channel");
  return channel;
}

test("a half-written message marks its room with a pencil and waits in Drafts, where Delete has an Undo", async ({ page, request }) => {
  const channel = await firstChannel(request);
  const text = `half written ${tag()}`;
  await open(page, `#/c/${channel.id}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type(text);
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toHaveCount(0);

  await open(page, `#/c/${FRONTEND}`);
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toBeVisible();
  await expect(draftsRow(page)).toContainText("1");

  await draftsRow(page).click();
  const drafts = page.getByTestId("drafts-page");
  const item = drafts.locator("li[data-draft-key]").filter({ hasText: text });
  await expect(item).toContainText(`#${channel.name}`);
  await item.locator("[data-draft-open]").click();
  await expect(composerInput(conversation(page))).toHaveText(text);

  await draftsRow(page).click();
  await item.hover();
  await item.locator("[data-draft-delete]").click();
  await expect(item).toHaveCount(0);
  await expect(drafts.getByText("No drafts")).toBeVisible();
  await expect(drafts.getByRole("button", { name: "New message" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(item).toBeVisible();
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toBeVisible();

  await item.locator("[data-draft-open]").click();
  await composerInput(conversation(page)).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await open(page, `#/c/${FRONTEND}`);
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toHaveCount(0);
});

test("a thread reply draft is kept per room and opens its thread from Drafts", async ({ page, request }) => {
  const channel = await firstChannel(request);
  const text = `thread reply ${tag()}`;
  const thread = "p1";
  await open(page, `#/c/${channel.id}?thread=${thread}`);
  const pane = page.getByTestId("thread-pane");
  await composerInput(pane).click();
  await page.keyboard.type(text);
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("chat.draft.thread:")));
  expect(key).toBe(`chat.draft.thread:${channel.id}:${thread}`);

  await page.goto("/#/c/drafts");
  const item = page.getByTestId("drafts-page").locator("li[data-draft-key]").filter({ hasText: text });
  await expect(item).toContainText(`Thread in #${channel.name}`);
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toHaveCount(0);
  await item.locator("[data-draft-open]").click();
  await expect(composerInput(page.getByTestId("thread-pane"))).toHaveText(text);
});

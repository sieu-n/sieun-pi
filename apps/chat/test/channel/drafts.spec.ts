import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, tag, VENT } from "./helpers";

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
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("chat.draft.reply:")));
  expect(key).toBe(`chat.draft.reply:${channel.id}:${thread}`);

  await page.goto("/#/c/drafts");
  const item = page.getByTestId("drafts-page").locator("li[data-draft-key]").filter({ hasText: text });
  await expect(item).toContainText(`Thread in #${channel.name}`);
  await expect(sidebarRow(page, channel.id).locator("[data-draft]")).toHaveCount(0);
  await item.locator("[data-draft-open]").click();
  await expect(composerInput(page.getByTestId("thread-pane"))).toHaveText(text);
});

test("thread drafts saved before drafts named their room move to their room, and one no channel claims stays readable", async ({ page }) => {
  const word = tag();
  const job = `${VENT}:14`;
  const old = {
    "chat.draft.thread:p3": `one channel has p3 ${word}`,
    [`chat.draft.thread:${job}`]: `a job thread ${word}`,
    "chat.draft.thread:p1": `both channels have p1 ${word}`,
    "chat.draft.thread:ch_general:p2": JSON.stringify({ text: `written by 363f5088 ${word}`, at: Date.now() }),
  };
  // The seed has p3 only in #pi-cutover, but other specs post and reply in #general and add channels, so their p3 lookups answer as unseeded.
  await page.route(/\/api\/c\/[^/]+\/replies\/p3$/, (route) =>
    route.request().url().includes("/api/c/ch_cutover/") ? route.fallback() : route.fulfill({ status: 404, json: { error: "No post p3." } }),
  );
  await page.goto("/#/c/drafts");
  await page.getByTestId("drafts-page").waitFor();
  await page.evaluate((seed) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("chat.draft.")) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  }, old);
  // The page looks the old drafts up as reads ahead, which wait behind the rooms it reads ahead; at load 300 that took more than 5 s.
  const lookedUp = page.waitForResponse((response) => response.url().endsWith("/api/c/ch_cutover/replies/p3"));
  await page.reload();
  await lookedUp;

  const list = page.getByTestId("drafts-page");
  const item = (text: string) => list.locator("li[data-draft-key]").filter({ hasText: text });
  await expect(item("one channel has p3")).toHaveAttribute("data-draft-key", "reply:ch_cutover:p3");
  await expect(item("one channel has p3")).toContainText("Thread in #pi-cutover");
  await expect(item("a job thread")).toHaveAttribute("data-draft-key", `reply:dm_vent:${job}`);
  await expect(item("written by 363f5088")).toHaveAttribute("data-draft-key", "reply:ch_general:p2");
  await expect(item("both channels have p1").locator("[data-draft-legacy]")).toContainText("Thread reply, room not known");
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("chat.draft.")).sort());
  expect(keys).toEqual(["chat.draft.reply:ch_cutover:p3", "chat.draft.reply:ch_general:p2", `chat.draft.reply:dm_vent:${job}`, "chat.draft.thread:p1"].sort());

  await item("one channel has p3").locator("[data-draft-open]").click();
  await expect(composerInput(page.getByTestId("thread-pane"))).toHaveText(`one channel has p3 ${word}`);
  await page.goto("/#/c/ch_general?thread=p1");
  await expect(composerInput(page.getByTestId("thread-pane"))).toHaveText(`both channels have p1 ${word}`);
  await page.goto("/#/c/drafts");
  await expect(item("both channels have p1")).toHaveAttribute("data-draft-key", "reply:ch_general:p1");
});

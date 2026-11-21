import { CRAWLER, CRAWLER_AGENT, HARNESS, HARNESS_AGENT, VENT, expect, resetFixture, test } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

const rows = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "For you asks" }).locator("li");

test("For you lists every chat's open asks, newest first, with the chat, the ids and the age", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await expect(page.getByRole("heading", { name: "For you", level: 1 })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toContainText("AI harness developer environment VP");
  await expect(rows(page).nth(0)).toContainText("t1 · p4");
  await expect(rows(page).nth(0)).toContainText("Pick the day for the production cutover.");
  await expect(rows(page).nth(1)).toContainText("Crawler VP");
  await expect(rows(page).nth(2)).toContainText("Vent");
  await expect(page.getByLabel("Unanswered").first()).toBeVisible();
});

test("a row opens the ask beside the list, with its choices, links and step", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await rows(page).nth(0).getByRole("button", { name: /Open t1 from AI harness/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/for-you/${HARNESS_AGENT}/t1$`));
  const detail = page.getByRole("region", { name: "Ask" });
  await expect(detail.getByRole("button", { name: "Thursday 09:00" })).toBeVisible();
  await expect(detail.getByText("Cutover plan")).toBeVisible();
  await expect(detail.getByText("Deploy the chat to production")).toBeVisible();
  await expect(detail.locator(`a[href="#/board/${HARNESS_AGENT}?focus=p4"]`)).toBeVisible();
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/#\/c\/for-you$/);
});

test("a choice answers the ask in place: it leaves the open list and shows in Done with the reply", async ({ page, request, chatServer }) => {
  await page.goto(`/#/c/for-you/${CRAWLER_AGENT}/t1`);
  await page.getByRole("region", { name: "Ask" }).getByRole("button", { name: "Raise it" }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Ask" })).toContainText("You: Raise it");
  const board = await (await request.get(`${chatServer}/api/threads/${CRAWLER}/board`)).json();
  expect(board.board.todos[0]).toMatchObject({ id: "t1", done: true, reply: "Raise it" });
  await page.getByRole("button", { name: "For you filters" }).click();
  await page.getByRole("menuitemradio", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  await expect(rows(page).filter({ hasText: "Raise the crawler's pool class to high?" })).toHaveCount(1);
});

test("a typed reply answers an ask that has no choices", async ({ page }) => {
  await page.goto(`/#/c/for-you/${HARNESS_AGENT}/t2`);
  const field = page.getByRole("textbox", { name: "Reply to t2" });
  await expect(field).toBeFocused();
  await field.fill("Looks good, ship it to staging");
  await field.press("Enter");
  await expect(page.getByRole("region", { name: "Ask" })).toContainText("You: Looks good, ship it to staging");
  await expect(rows(page)).toHaveCount(3);
});

test("the hover action dismisses an ask from the list, and Done reopens it", async ({ page }) => {
  await page.goto("/#/c/for-you");
  const vent = rows(page).filter({ hasText: "Vent" });
  await vent.hover();
  await vent.getByRole("button", { name: "Dismiss t1" }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "For you filters" }).click();
  await page.getByRole("menuitemradio", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  const done = rows(page).filter({ hasText: "Should the relay page you" });
  await done.hover();
  await done.getByRole("button", { name: "Reopen t1" }).click();
  await expect(done).toHaveCount(0);
  expect(VENT).toBeTruthy();
});

test("the filter keeps only one type, and an empty view says so", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await page.getByRole("button", { name: "For you filters" }).click();
  await page.getByRole("menuitemradio", { name: "Your notes" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No notes of yours")).toBeVisible();
  await expect(page.getByRole("button", { name: "For you filters" })).toHaveText(/Your notes open/);
});

test("Dismiss shows Undo in its toast, and Undo brings the ask back", async ({ page }) => {
  await page.goto("/#/c/for-you");
  const vent = rows(page).filter({ hasText: "Vent" });
  await vent.hover();
  await vent.getByRole("button", { name: "Dismiss t1" }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(4);
});

test("the reply box keeps Shift+Enter line breaks and Escape closes it", async ({ page, request, chatServer }) => {
  await page.goto(`/#/c/for-you/${HARNESS_AGENT}/t2`);
  const box = page.getByRole("textbox", { name: /Reply to t2/ });
  await expect(box).toBeFocused();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(3);
  const board = await (await request.get(`${chatServer}/api/threads/${HARNESS}/board`)).json();
  expect(board.board.todos.find((t: { id: string }) => t.id === "t2").reply).toBe("line one\nline two");
  await page.goto(`/#/c/for-you/${CRAWLER_AGENT}/t1`);
  const detail = page.getByRole("region", { name: "Ask" });
  await detail.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /Reply to t1/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: /Reply to t1/ })).toHaveCount(0);
  await expect(detail).toBeVisible();
});

test("j and k move between asks, e dismisses the open one and Escape closes it", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`#/c/for-you/${HARNESS_AGENT}/t1$`));
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/#\/c\/for-you\/.+\/t\d+$/);
  const second = page.url();
  await page.keyboard.press("k");
  await expect(page).toHaveURL(new RegExp(`#/c/for-you/${HARNESS_AGENT}/t1$`));
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(second);
  await page.keyboard.press("e");
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/c\/for-you$/);
});

test("Remind me hides an ask until its time and Snoozed lists it", async ({ page, request, chatServer }) => {
  await page.goto(`/#/c/for-you/${CRAWLER_AGENT}/t1`);
  await page.getByRole("region", { name: "Ask" }).getByRole("button", { name: "Remind me" }).click();
  await page.getByRole("menuitem", { name: "In 1 hour" }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Ask" })).toContainText("Snoozed until");
  const board = await (await request.get(`${chatServer}/api/threads/${CRAWLER}/board`)).json();
  expect(Date.parse(board.board.todos[0].remindAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
  await page.getByRole("button", { name: "For you filters" }).click();
  await page.getByRole("menuitemradio", { name: "Snoozed" }).click();
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("until");
});

test("New note adds a note of your own, and Remove has Undo", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await page.getByRole("button", { name: "New note" }).click();
  const dialog = page.getByRole("dialog", { name: "New note" });
  await dialog.getByRole("textbox", { name: "Note" }).fill("Read the cutover plan tonight");
  await dialog.getByRole("textbox", { name: "Note" }).press("Enter");
  await expect(dialog).toHaveCount(0);
  const note = rows(page).filter({ hasText: "Read the cutover plan tonight" });
  await expect(note).toContainText("your note");
  const detail = page.getByRole("region", { name: "Ask" });
  await detail.getByRole("button", { name: "Remove" }).click();
  await expect(note).toHaveCount(0);
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).click();
  await expect(note).toHaveCount(1);
});

import { expect, test, type Page } from "@playwright/test";
import { HARNESS_AGENT, VENT, resetFixture } from "./helpers";

const server = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186";
const VENT_AGENT = "ag_vent";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, page }) => {
  await resetFixture(request);
  await page.addInitScript(() => { if (!sessionStorage.getItem("keep-folds")) localStorage.removeItem("chat.sidebarFolds"); });
});

const sidebar = (page: Page) => page.locator('[data-testid="sidebar"][data-root="board"]');
const row = (page: Page, agent: string) => sidebar(page).locator(`a[href="#/board/${agent}"]`);

test("the Board sidebar lists All boards, then the boards that wait on the owner with their open asks", async ({ page }) => {
  await page.goto("/#/board");
  await expect(sidebar(page).getByRole("link", { name: "All boards" })).toHaveAttribute("aria-current", "page");
  const needsYou = sidebar(page).getByRole("region", { name: "Needs you" });
  await expect(needsYou.locator("a[data-sidebar-row]")).toHaveCount(3);
  await expect(row(page, HARNESS_AGENT)).toContainText("2");
  await expect(row(page, HARNESS_AGENT)).toHaveAttribute("title", "AI harness developer environment VP: 2 asks for you");
  await expect(page.getByTestId("main-panel").getByRole("heading", { name: "All boards" })).toBeVisible();
});

test("the sidebar and the index share one store, so opening a board and coming back reads /api/boards no more", async ({ page }) => {
  let reads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/boards") reads++; });
  await page.goto("/#/board");
  await expect(page.getByRole("region", { name: "Plans" }).locator("li")).toHaveCount(3);
  await expect(sidebar(page).locator("a[data-sidebar-row]")).toHaveCount(4);
  await page.waitForLoadState("networkidle");
  expect(reads).toBeLessThanOrEqual(2);
  const settled = reads;
  await row(page, HARNESS_AGENT).click();
  await expect(page.getByTestId("main-panel").getByRole("region", { name: "For you" })).toBeVisible();
  await sidebar(page).getByRole("link", { name: "All boards" }).click();
  await expect(page.getByRole("region", { name: "Plans" }).locator("li")).toHaveCount(3);
  expect(reads).toBe(settled);
});

test("a board row opens that board in the main view with no back link", async ({ page }) => {
  await page.goto("/#/board");
  await row(page, HARNESS_AGENT).click();
  await expect(page).toHaveURL(new RegExp(`#/board/${HARNESS_AGENT}$`));
  await expect(row(page, HARNESS_AGENT)).toHaveAttribute("aria-current", "page");
  await expect(sidebar(page).getByRole("link", { name: "All boards" })).not.toHaveAttribute("aria-current", "page");
  const main = page.getByTestId("main-panel");
  await expect(main.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await expect(main.getByRole("link", { name: "All boards" })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Open chat" })).toBeVisible();
});

test("answering an ask updates the sidebar badge live, and a board with nothing left moves to Boards", async ({ page, request }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  await page.getByRole("region", { name: "For you" }).getByRole("button", { name: "Friday 09:00" }).click();
  await expect(row(page, HARNESS_AGENT).locator(".trail")).toHaveText("1");
  const done = await request.post(`${server}/api/threads/${VENT}/board`, { data: { ops: [{ op: "todo_update", id: "t1", done: true, reply: "Page me" }] } });
  expect(done.ok()).toBe(true);
  await expect(sidebar(page).getByRole("region", { name: "Boards" }).locator(`a[href="#/board/${VENT_AGENT}"]`)).toBeVisible();
  await expect(sidebar(page).getByRole("region", { name: "Needs you" }).locator("a[data-sidebar-row]")).toHaveCount(2);
});

test("a folded section keeps the open board, shows its count and stays folded after a reload", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  const needsYou = sidebar(page).getByRole("region", { name: "Needs you" });
  await needsYou.getByRole("button", { name: /Needs you/ }).click();
  await expect(needsYou.getByRole("button", { name: /Needs you/ })).toHaveAttribute("aria-expanded", "false");
  await expect(needsYou.locator("a[data-sidebar-row]")).toHaveCount(1);
  await expect(row(page, HARNESS_AGENT)).toBeVisible();
  await expect(needsYou.getByRole("button", { name: /Needs you/ })).toContainText("3");
  await page.evaluate(() => sessionStorage.setItem("keep-folds", "1"));
  await page.reload();
  await expect(sidebar(page).getByRole("region", { name: "Needs you" }).locator("a[data-sidebar-row]")).toHaveCount(1);
});

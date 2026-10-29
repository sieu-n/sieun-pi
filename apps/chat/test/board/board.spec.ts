import { expect, test } from "@playwright/test";
import { HARNESS, HARNESS_AGENT, resetFixture } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => { await resetFixture(request); });

test("a chat's board shows its asks, the plan by status, its duties and its check-in", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  await expect(page.getByRole("region", { name: "For you" })).toContainText("Pick the day for the production cutover.");
  await expect(page.getByRole("region", { name: "In progress" })).toContainText("Move :5182 onto pi-host");
  await expect(page.getByRole("region", { name: "In progress" })).toContainText("1 of 4 done");
  await expect(page.getByRole("region", { name: "To do" })).toContainText("waits until");
  await expect(page.getByRole("region", { name: "Duties" })).toContainText("2 duties, 1 off target");
  await expect(page.getByRole("region", { name: "Check-in" })).toContainText("Check-in every 120 min");
  await expect(page.locator('[data-board-id="p1"]')).toHaveAttribute("href", `#/board/${HARNESS}?focus=p1`);
});

test("a goal unfolds to its steps with their owners and waits, and Show done reveals done and dropped steps", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  await page.getByRole("button", { name: "Expand p1" }).click();
  await expect(page.locator('[data-step="p2"]')).toContainText("Rerun the cross-box test");
  await expect(page.locator('[data-step="p5"]')).toContainText("waits for Crawler VP gets a pool slot");
  await expect(page.locator('[data-step="p3"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Show done (2)" }).click();
  await expect(page.locator('[data-step="p3"]')).toBeVisible();
  await expect(page.locator('[data-step="p6"]')).toBeVisible();
});

test("a chip link with focus unfolds the plan to that step and marks it", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}?focus=p3`);
  await expect(page.locator('[data-step="p3"]')).toBeVisible();
  await expect(page.locator('[data-step="p3"]')).toHaveClass(/flash/);
});

test("an ask answered on the board leaves the open list and the server keeps the reply", async ({ page, request }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const asks = page.getByRole("region", { name: "For you" });
  await asks.getByRole("button", { name: "Friday 09:00" }).click();
  await expect(asks.locator(".ask-row")).toHaveCount(1);
  const board = await (await request.get(`${process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186"}/api/threads/${HARNESS}/board`)).json();
  expect(board.board.todos.find((todo: { id: string }) => todo.id === "t1")).toMatchObject({ done: true, reply: "Friday 09:00" });
  await asks.getByRole("button", { name: "Done (2)" }).click();
  await expect(asks).toContainText("You: Friday 09:00");
});

test("a duty pauses from its switch and shows its runs when opened", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await duties.getByRole("switch", { name: "Relay uptime on" }).click();
  await expect(duties.getByRole("switch", { name: "Relay uptime on" })).not.toBeChecked();
  await duties.getByRole("button", { name: /Relay uptime/ }).first().click();
  await expect(duties).toContainText("Runs");
  await expect(duties).toContainText("Paused.");
});

test("the check-in menu pauses check-ins and resumes them", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const checkIn = page.getByRole("region", { name: "Check-in" });
  await checkIn.getByRole("button", { name: "Check-in settings" }).click();
  await page.getByRole("menuitem", { name: "Pause until I resume" }).click();
  await expect(checkIn).toContainText("Check-in paused until you resume it");
  await expect(checkIn.getByRole("button", { name: "Check-in settings" })).toHaveText(/Paused/);
  await checkIn.getByRole("button", { name: "Check-in settings" }).click();
  await page.getByRole("menuitem", { name: "Resume check-ins" }).click();
  await expect(checkIn).toContainText("Check-in every 120 min");
});

test("the board index lists every chat's plan, then duties and check-ins by when they are due", async ({ page }) => {
  await page.goto("/#/board");
  const plans = page.getByRole("region", { name: "Plans" });
  await expect(plans.locator("li")).toHaveCount(3);
  await expect(plans).toContainText("2 for you");
  await expect(page.getByText("Relay uptime").first()).toBeVisible();
  await plans.locator(`a[data-chat="${HARNESS_AGENT}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/board/${HARNESS_AGENT}$`));
});

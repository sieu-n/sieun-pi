import { expect, test } from "@playwright/test";
import { open, row, VENT } from "./helpers";

test("a board id chip opens the home chat's board in the side pane, focused on that id", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  const chip = row(page, "p6").locator('[data-board-id="t1"]');
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/board=t1/);
  const pane = page.getByTestId("board-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("Pick the day for the production cutover");
  await expect(page.getByTestId("board-button")).toHaveAttribute("aria-pressed", "true");
});

test("the Board button toggles the chat's board, and a thread pill swaps the pane to the thread", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  await page.getByTestId("board-button").click();
  await expect(page.getByTestId("board-pane")).toBeVisible();
  await page.getByTestId("board-button").click();
  await expect(page.getByTestId("board-pane")).toBeHidden();
  await page.getByTestId("board-button").click();
  await row(page, "t12").locator("[data-thread-pill]").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("board-pane")).toBeHidden();
  await expect(page).not.toHaveURL(/board=/);
});

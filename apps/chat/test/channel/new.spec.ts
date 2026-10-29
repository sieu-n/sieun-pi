import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

test("New channel makes the room and opens it", async ({ page }) => {
  await open(page, "#/c/new?kind=channel", "main-panel");
  await expect(page.getByLabel("Name")).toBeVisible();
  const name = `room ${tag()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Purpose/).fill("A spec room");
  await page.getByTestId("main-panel").getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_/);
  await expect(page.getByTestId("conversation-title")).toHaveText(name.replace(" ", "-"));
  await expect(conversation(page)).toContainText("No messages yet.");
});

test("New chat starts an agent from its first message", async ({ page }) => {
  await open(page, "#/c/new?kind=chat", "composer-input");
  const input = composerInput(page);
  await expect(input).toHaveAttribute("aria-label", "Message your agents");
  await input.click();
  const word = tag();
  await page.keyboard.type(`hello ${word}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\/dm_/);
  await expect(conversation(page).locator(".row.own").filter({ hasText: word })).toBeVisible();
});

test("Messages with nothing open asks to pick a conversation", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await expect(page.getByText("Pick a conversation")).toBeVisible();
});

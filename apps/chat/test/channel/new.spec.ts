import { expect, test } from "@playwright/test";
import { open, tag } from "./helpers";

test("New channel makes the room and opens it", async ({ page }) => {
  await open(page, "#/c/new?kind=channel", "main-panel");
  await expect(page.getByLabel("Name")).toBeVisible();
  const name = `room ${tag()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Purpose/).fill("A spec room");
  await page.getByTestId("main-panel").getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_/);
  const slug = name.replace(" ", "-");
  await expect(page.getByTestId("conversation-title")).toHaveText(slug);
  const intro = page.getByTestId("channel-intro");
  await expect(intro.getByRole("heading", { name: `#${slug}` })).toBeVisible();
  await expect(intro).toContainText(`This is the very beginning of the #${slug} channel.`);
  await expect(intro).toContainText("A spec room");
});

test("Cmd N and an old New chat link open the DM picker, and picking an agent opens its DM", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+n`);
  await expect(page).toHaveURL(/#\/c\/new\?kind=dm$/);
  await expect(page.getByRole("heading", { name: "New message" })).toBeVisible();
  await page.goto("/#/c/new?kind=chat");
  await expect(page.getByRole("heading", { name: "New message" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".recent button.agent").filter({ hasText: "Vent" }).click();
  await expect(page).toHaveURL(/#\/c\/dm_vent$/);
});

test("Messages with nothing open asks to pick a conversation", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await expect(page.getByText("Pick a conversation")).toBeVisible();
});

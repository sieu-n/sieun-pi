import { expect, test } from "@playwright/test";
import { conversation, open, row, VENT, VENT_JOB } from "./helpers";

test("a channel thread shows the root post, an N replies rule and the replies as Slack rows, under a Thread title with the channel", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  const pill = row(page, "p1").locator("[data-thread-pill]");
  const count = Number((await pill.textContent())?.match(/(\d+) repl/)?.[1]);
  expect(count).toBeGreaterThanOrEqual(2);
  await pill.click();
  await expect(page).toHaveURL(/thread=p1/);
  const panel = page.getByTestId("side-panel");
  await expect(panel.locator(".panel-header h2")).toHaveText("Thread");
  await expect(panel.getByTestId("thread-room")).toHaveText("#pi-cutover");
  await expect(panel).toHaveAttribute("aria-label", "Thread");
  const pane = page.getByTestId("thread-pane");
  const posts = pane.locator("[data-message-id]");
  await expect(posts.first()).toHaveAttribute("data-message-id", "p1");
  await expect(posts.first()).toContainText("what still blocks the migration?");
  await expect(pane.getByTestId("thread-replies-divider")).toHaveText(`${count} replies`);
  await expect(pane).toContainText("Two of five");
  await expect(pane).toContainText("The crawler still uses the old relay port.");
  await expect(pane.locator(".bubble")).toHaveCount(0);
  await expect(pane.getByTestId("composer-input")).toHaveAttribute("aria-label", "Reply…");
  await page.getByRole("button", { name: "Close thread" }).click();
  await expect(pane).toBeHidden();
  await expect(page).not.toHaveURL(/thread=/);
});

test("the channel header shows the purpose and a member button whose list names every member and their status", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  await expect(page.getByTestId("conversation-title")).toHaveText("pi-cutover");
  await expect(page.getByTestId("channel-purpose")).toHaveAttribute("title", "Move :5182 onto pi-host (p1128)");
  const button = page.getByTestId("channel-members");
  await expect(button).toHaveAttribute("aria-label", "Members, 4 members");
  await expect(button.locator(".avatar")).toHaveCount(3);
  await expect(button.locator(".count")).toHaveText("4");
  await button.click();
  const list = page.getByRole("dialog", { name: "Members" });
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(list.getByRole("option", { name: /Crawler VP/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /AI harness developer environment VP.*Working now/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /You/ })).toBeVisible();
  await list.getByRole("option", { name: /frontend bro/ }).click();
  await expect(page).toHaveURL(/#\/c\/dm_/);
});

test("a DM keeps its bubbles, its header and its job thread pane", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  await expect(page.getByTestId("channel-members")).toHaveCount(0);
  await expect(row(page, "e2").locator(".bubble").first()).toBeVisible();
  await row(page, "t12").locator("[data-thread-pill]").click();
  await expect(page).toHaveURL(new RegExp(`thread=${encodeURIComponent(VENT_JOB)}`));
  const panel = page.getByTestId("side-panel");
  await expect(panel.getByTestId("thread-room")).toHaveCount(0);
  await expect(panel.locator(".panel-header h2")).toContainText("Read the canary logs");
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByTestId("thread-replies-divider")).toHaveCount(0);
  await expect(pane.getByTestId("composer-input")).toHaveAttribute("aria-label", "Reply to thread");
  await expect(conversation(page).locator(".bubble").first()).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { conversation, open, row, tag } from "../channel/helpers.ts";

/**
 * An agent's profile from its DM, as Slack opens a person's: the header name, a post's author name and avatar open one profile card with
 * Message and Open agent, the header menu has Open agent and Jobs, and an empty DM opens on the agent's intro.
 */
const card = (page: import("@playwright/test").Page) => page.getByTestId("profile-card");

test("an empty DM opens on the agent's intro, and its header name opens the profile card", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: `profile agent ${tag()}`, test: true } })).json()) as { id: string; name: string; room: string };
  await open(page, `#/c/${agent.room}`);
  const intro = page.getByTestId("dm-intro");
  await expect(intro).toContainText(agent.name);
  await expect(intro).toContainText(`This conversation is just between you and ${agent.name}`);
  await expect(page.getByText("No messages yet.")).toHaveCount(0);

  const title = page.getByTestId("dm-title-button");
  await title.click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByTestId("profile-name")).toHaveText(agent.name);
  await expect(card(page).getByTestId("profile-jobs")).toHaveText("No jobs yet");
  await title.click();
  await expect(card(page)).toHaveCount(0);

  await title.click();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);

  await title.click();
  await card(page).getByTestId("profile-view").click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}$`));
  await expect(card(page)).toHaveCount(0);

  await open(page, `#/c/${agent.room}`);
  await intro.getByRole("link", { name: "Open agent" }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}$`));
});

test("the DM menu opens the agent and its Threads tab", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: `menu agent ${tag()}`, test: true } })).json()) as { id: string; room: string };
  await open(page, `#/c/${agent.room}`);
  await conversation(page).getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Jobs" }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}\\?section=threads$`));
  await open(page, `#/c/${agent.room}`);
  await conversation(page).getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Open agent" }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}$`));
});

test("an agent post's name and avatar open its profile card, and Message opens its DM", async ({ page }) => {
  await open(page, "#/c/dm_vent?m=p10");
  const post = row(page, "p10");
  await post.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await conversation(page).getByRole("button", { name: "Conversation actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Mute conversation" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Close conversation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await post.locator("[data-author-button]").click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-agent", "ag_vent");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);

  await post.locator("[data-author-avatar]").click();
  await expect(card(page)).toBeVisible();
  await card(page).getByTestId("profile-message").press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/c\/dm_vent$/);
});

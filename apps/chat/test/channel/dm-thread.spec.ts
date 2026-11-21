import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

test("an agent's DM post takes Reply in thread, and the thread pane holds his reply and the agent's answer", async ({ page }) => {
  // The fixture agent's answer comes after a few seconds of streamed words, on top of the page's first load.
  test.setTimeout(60_000);
  await open(page, "#/c/dm_vent");
  const agentPost = conversation(page).locator('[data-message-id^="p"]:not(.own)').last();
  const rootId = (await agentPost.getAttribute("data-message-id"))!;
  await agentPost.scrollIntoViewIfNeeded();
  await agentPost.hover();
  await agentPost.getByRole("button", { name: "Reply in thread" }).click();
  await expect(page).toHaveURL(new RegExp(`thread=${rootId}(&|$)`));
  const panel = page.getByTestId("side-panel");
  await expect(panel.locator(".panel-header h2")).toHaveText("Thread");
  await expect(panel.getByTestId("thread-room")).toHaveText("Vent");
  const pane = page.getByTestId("thread-pane");
  await expect(pane.locator("[data-message-id]").first()).toHaveAttribute("data-message-id", rootId);

  const text = `dm thread reply ${tag()}`;
  await composerInput(pane).fill(text);
  await composerInput(pane).press("Enter");
  await expect(pane).toContainText(text);
  await expect(pane).toContainText(`You said: "`, { timeout: 15_000 });
  await expect(conversation(page)).not.toContainText(text);
  const pill = conversation(page).locator(`[data-message-id="${rootId}"] [data-thread-pill]`);
  await expect(pill).toContainText(/\d+ repl/);

  await page.getByRole("button", { name: "Close thread" }).click();
  await expect(pane).toBeHidden();
  await pill.click();
  await expect(page).toHaveURL(new RegExp(`thread=${rootId}(&|$)`));
  await expect(page.getByTestId("thread-pane")).toContainText(text);
});

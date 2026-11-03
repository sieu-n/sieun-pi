import { expect, test } from "@playwright/test";
import { composerInput, conversation, CRAWLER, FRONTEND, open, tag } from "./helpers";

/** The patterns config/AGENTS.md rule 5 asks agents to write, as one post, and what each must render as in a room post. */
test("a post's wiki links, loopback links, app links, bare paths and job names render as pills, and its wiki page as a card", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const word = tag();
  await composerInput(conversation(page)).click();
  await page.keyboard.insertText(
    `pills ${word}: wiki:domains/devops/sw-factory-threads/storage.html, localhost:5180/campaigns, /home/sieun/work/post-parity/, ` +
      `\`apps/chat/server/http.ts:42\` and https://h.ts.net:5184/#/c/${CRAWLER}`,
  );
  await page.keyboard.press("Enter");
  const post = conversation(page).locator("li[data-message-id]").filter({ hasText: `pills ${word}` }).first();
  await expect(post.locator('a.wiki-link[data-target="wiki:domains/devops/sw-factory-threads/storage.html"]')).toBeVisible();
  await expect(post.locator("a.local-link")).toHaveText("localhost:5180/campaigns");
  await expect(post.locator("a.local-link")).toHaveAttribute("href", "http://localhost:5180/campaigns");
  await expect(post.locator('a.path-pill[data-target="file:/home/sieun/work/post-parity/"]')).toBeVisible();
  await expect(post.locator('a.path-pill[data-target="file:apps/chat/server/http.ts:42"]')).toBeVisible();
  const app = post.locator("a.app-link");
  await expect(app).toHaveAttribute("href", `#/c/${CRAWLER}`);
  await expect(app).not.toHaveAttribute("target", "_blank");
  const card = post.locator('[data-wiki-card="domains/devops/sw-factory-threads/storage.html"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".title")).not.toBeEmpty();
  await app.click();
  await expect(page).toHaveURL(new RegExp(`#/c/${CRAWLER}`));
});

test("the rich answer shows a card for the wiki page it links", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const rich = conversation(page).locator("li[data-message-id]").filter({ has: page.locator(".callout-important") });
  await expect(rich.locator('[data-wiki-card="sessions/2026/10/28/board-panel.md"]')).toBeVisible();
});

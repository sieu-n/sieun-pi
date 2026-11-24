import { expect, test } from "@playwright/test";
import { open as openRoom, tag } from "../channel/helpers.ts";

/**
 * Save in the wiki pane (lib/later.svelte.ts `togglePage`): the page goes to Saved as a note whose text is its link, Saved shows it as a
 * Wiki page row that opens the page, and the button then removes it. The save toast's Add memo writes a memo on it. The wiki is mocked, so
 * the spec reads no real page.
 */
test.describe.configure({ timeout: 60_000 });

test("the owner saves a wiki page with a memo, Saved lists it as a Wiki page that opens it, and the button removes it", async ({ page, request }) => {
  const word = tag();
  const path = `sessions/2026/11/22/save-me-${word}.html`;
  const title = `Save me ${word}`;
  await page.route((url) => url.pathname.startsWith("/wiki/"), (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("format") === "md") return route.fulfill({ contentType: "text/markdown", body: `---\ntitle: "${title}"\n---\n` });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>${title} · llm-wiki</title></head><body><article class="page"><h1>${title}</h1><p>Body.</p></article></body></html>` });
  });
  await openRoom(page, "#/c/ch_cutover");
  await page.goto(`/#/c/ch_cutover?view=${encodeURIComponent(`wiki:${path}`)}`);
  const save = page.locator("[data-save-page]");
  await expect(save).toHaveAttribute("aria-label", "Save", { timeout: 15_000 });
  await expect(page.locator(".wiki-title")).toHaveText(title);
  await save.click();
  const toast = page.locator(".toast").filter({ hasText: "Saved" });
  await expect(toast).toBeVisible();
  await expect(save).toHaveAttribute("aria-label", "Remove from Saved");
  await toast.getByRole("button", { name: "Add memo" }).click();
  const prompt = page.getByRole("dialog", { name: "Memo for this saved page" });
  await expect(prompt).toBeVisible();
  const saveBox = (await save.boundingBox())!;
  const promptBox = (await prompt.boundingBox())!;
  expect(promptBox.y).toBeGreaterThanOrEqual(saveBox.y + saveBox.height);
  expect(Math.abs(promptBox.x + promptBox.width - (saveBox.x + saveBox.width))).toBeLessThan(2);
  await page.locator("[data-memo-field]").fill(`reread before ${word}`);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-memo-field]")).toHaveCount(0);

  await expect.poll(async () => {
    const list = (await (await request.get("/api/later?state=open")).json()) as { items: { id: string; text: string; memo?: string }[] };
    return list.items.find((item) => item.text === `[${title}](wiki:${path})`)?.memo;
  }).toBe(`reread before ${word}`);

  await page.goto("/#/c/saved");
  const row = page.locator("[data-later-id]").filter({ hasText: title });
  await expect(row.locator("[data-later-page]")).toHaveText("Wiki page");
  await expect(row.locator("[data-later-memo]")).toHaveText(`reread before ${word}`);
  await row.locator("[data-later-open]").click();
  await expect(page).toHaveURL(new RegExp(`view=${encodeURIComponent(`wiki:${path}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.locator(".wiki-title")).toHaveText(title);

  await page.locator("[data-save-page]").click();
  await expect(page.getByText("Removed from Saved")).toBeVisible();
  await expect(page.locator("[data-save-page]")).toHaveAttribute("aria-label", "Save");
});

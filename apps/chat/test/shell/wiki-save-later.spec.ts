import { expect, test } from "@playwright/test";
import { open as openRoom, tag } from "../channel/helpers.ts";

/**
 * Save for later in the wiki pane (lib/later.svelte.ts `togglePage`): the page goes to Later as a note whose text is its link, Later shows
 * it as a Wiki page row that opens the page, and the button then removes it. The wiki is mocked, so the spec reads no real page.
 */
test.describe.configure({ timeout: 60_000 });

test("the owner saves a wiki page for later, Later lists it as a Wiki page that opens it, and the button removes it", async ({ page, request }) => {
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
  await expect(save).toHaveAttribute("aria-label", "Save for later", { timeout: 15_000 });
  await expect(page.locator(".wiki-title")).toHaveText(title);
  await save.click();
  await expect(page.getByText("Saved for later")).toBeVisible();
  await expect(save).toHaveAttribute("aria-label", "Remove from Later");

  const list = (await (await request.get("/api/later?state=open")).json()) as { items: { id: string; text: string }[] };
  expect(list.items.some((item) => item.text === `[${title}](wiki:${path})`)).toBe(true);

  await page.goto("/#/c/later");
  const row = page.locator("[data-later-id]").filter({ hasText: title });
  await expect(row.locator("[data-later-page]")).toHaveText("Wiki page");
  await row.locator("[data-later-open]").click();
  await expect(page).toHaveURL(new RegExp(`view=${encodeURIComponent(`wiki:${path}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.locator(".wiki-title")).toHaveText(title);

  await page.locator("[data-save-page]").click();
  await expect(page.getByText("Removed from Later")).toBeVisible();
  await expect(page.locator("[data-save-page]")).toHaveAttribute("aria-label", "Save for later");
});

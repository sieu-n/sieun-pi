import { expect, test } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/** A post's link cards (lib/ui/LinkCards.svelte): one per wiki page and one per web link, as Slack unfurls it, in the order the text links them. */
test("a web link gets a Slack-style card beside the wiki page card, and a page with no preview gets none", async ({ page, request }) => {
  const asked: string[] = [];
  await page.route("**/api/unfurl?*", async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url")!;
    asked.push(url);
    const preview = url.includes("svelte.dev")
      ? { url, site: "Svelte", title: "Overview • Svelte Docs", description: "Svelte is a UI framework.", image: "https://svelte.dev/docs/svelte/overview/card.png" }
      : null;
    await route.fulfill({ json: { preview } });
  });
  const text = `links ${tag()}: https://svelte.dev/docs/svelte/overview then wiki:domains/devops/sw-factory-threads/storage.html and https://no-preview.example/x`;
  const id = ((await (await request.post("/api/c/dm_vent/send", { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id;
  await open(page, "#/c/dm_vent");
  const cards = row(page, id).locator("[data-link-cards] > a");
  await expect(cards).toHaveCount(2, { timeout: 15_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-web-card", "https://svelte.dev/docs/svelte/overview");
  await expect(cards.nth(0)).toContainText("Overview • Svelte Docs");
  await expect(cards.nth(0)).toContainText("Svelte is a UI framework.");
  await expect(cards.nth(0)).toHaveAttribute("target", "_blank");
  await expect(cards.nth(1)).toHaveAttribute("data-wiki-card", "domains/devops/sw-factory-threads/storage.html");
  expect(asked.sort()).toEqual(["https://no-preview.example/x", "https://svelte.dev/docs/svelte/overview"]);
});

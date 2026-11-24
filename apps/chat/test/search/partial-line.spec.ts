import { expect, test } from "@playwright/test";

/**
 * While Meilisearch fails or hangs, the server answers a search from memory and marks it partial with a `missing` line (search-engine.ts
 * `memoryAnswer`, p281). The Cmd K palette listed that line after every message hit, so with a page of hits it sat below the fold.
 */
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("Cmd K shows a partial answer's line above its message hits, in view", async ({ page }) => {
  const word = `zq${Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `partial-${word}`, members: [] } })).json()) as { id: string };
  await Promise.all(Array.from({ length: 20 }, (_, n) => page.request.post(`/api/c/${room.id}/send`, { data: { text: `${word} post ${n + 1}`, requestId: crypto.randomUUID() } })));
  await expect.poll(async () => ((await (await page.request.get(`/api/search?${new URLSearchParams({ q: word, limit: "1" })}`)).json()) as { total: number }).total).toBe(20);
  const note = "Search could not reach its index, so these hits hold only room posts and the newest thread messages.";
  await page.route(/\/api\/search\?/, async route => {
    const response = await route.fetch();
    const body = (await response.json()) as { missing?: { box: string; note: string }[] };
    await route.fulfill({ response, json: { ...body, partial: true, missing: [{ box: "index", note }, ...(body.missing ?? [])] } });
  });
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  const palette = page.locator("[data-search-palette]");
  await palette.getByRole("combobox").pressSequentially(word);
  await expect(palette.getByTestId("search-count")).toHaveText("20 messages");
  const line = palette.getByTestId("search-missing").filter({ hasText: note });
  await expect(line).toBeInViewport();
  const lineTop = (await line.boundingBox())!.y;
  const firstHit = palette.locator("[role=group][aria-label='Messages'] [data-search-result]").first();
  expect(lineTop).toBeLessThan((await firstHit.boundingBox())!.y);
});

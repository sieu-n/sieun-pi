import { expect, test } from "@playwright/test";

/**
 * The same search against the real pi-host. Set SEARCH_REAL_URL to a web build whose /api reaches the live chat server,
 * such as `CHAT_SERVER_URL=http://127.0.0.1:5184 npx vite --port 5192` in web/, and the spec reads real threads.
 */
const url = process.env.SEARCH_REAL_URL;
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.skip(!url, "SEARCH_REAL_URL is not set");
test.use({ baseURL: url ?? "http://127.0.0.1:5192" });

type Result = { hits: { conversation: { id: string }; messageId: string; snippet: string }[]; total: number };

test("a real message search shows the server's exact count and opens the hit at its message", async ({ page }) => {
  await page.goto("/#/c/new?kind=chat");
  const sample = (await (await page.request.get("/api/search?q=the&limit=1")).json()) as Result;
  test.skip(!sample.hits.length, "the real host has no indexed messages");
  const word = sample.hits[0]!.snippet.match(/<mark>([^<]+)<\/mark>/)![1]!;
  const real = (await (await page.request.get(`/api/search?q=${encodeURIComponent(word)}&limit=1`)).json()) as Result;
  await page.keyboard.press(`${mod}+k`);
  const field = page.locator("[data-search-palette]").getByRole("combobox");
  await field.fill(word);
  await expect(page.getByTestId("search-count")).toHaveText(`${real.total.toLocaleString("en-US")} ${real.total === 1 ? "message" : "messages"}`);
  const hits = page.locator("[data-search-palette] [role=group][aria-label='Most relevant'] [data-search-result]");
  await expect(hits.first()).toBeVisible();
  await hits.first().click();
  const hit = real.hits[0]!;
  await expect(page).toHaveURL(new RegExp(`#/c/${hit.conversation.id}\\?m=${hit.messageId}$`));
});

test("from:me on the real host counts only the owner's messages", async ({ page }) => {
  await page.goto("/#/c/new?kind=chat");
  const real = (await (await page.request.get("/api/search?q=the&from=owner&limit=1")).json()) as Result;
  await page.keyboard.press(`${mod}+k`);
  const field = page.locator("[data-search-palette]").getByRole("combobox");
  await field.pressSequentially("the from:me ");
  await expect(page.locator("[data-search-palette] .prefix .chip")).toContainText("from:@");
  await expect(page.getByTestId("search-count")).toHaveText(`${real.total.toLocaleString("en-US")} ${real.total === 1 ? "message" : "messages"}`);
});

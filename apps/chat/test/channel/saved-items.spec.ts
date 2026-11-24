import { expect, test, type Page } from "@playwright/test";
import { open, row as postRow, tag } from "./helpers.ts";

/**
 * Saved as the owner asked on 11-24 (#sw-factory-build p179): Later reads Saved, each saved item takes a memo he writes and edits, and the
 * page has one search box and Kind and In filters that narrow each tab and its count. Each test saves its own posts, under a fresh word, in
 * its own channel on the fixture server.
 */
test.describe.configure({ mode: "serial" });

type Saved = { room: string; name: string; ids: string[]; posts: string[] };
async function channel(page: Page, word: string, texts: string[]): Promise<Saved> {
  const name = `saved-${word}-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const ids: string[] = [];
  const posts: string[] = [];
  for (const text of texts) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
    posts.push(sent.item.id);
    ids.push(`${room}:${sent.item.id}`);
  }
  return { room, name, ids, posts };
}
const save = async (page: Page, s: Saved) => {
  for (const post of s.posts) await page.request.post("/api/later", { data: { room: s.room, post } });
};
const memoOf = async (page: Page, id: string): Promise<string | undefined> =>
  ((await (await page.request.get("/api/later?state=open")).json()) as { items: { id: string; memo?: string }[] }).items.find((i) => i.id === id)?.memo;
const tabBadge = (page: Page, name: string) => page.getByRole("tablist", { name: "Saved" }).getByRole("tab", { name: new RegExp(name) });

test("saving a post offers Add memo in the toast, and the memo shows on its Saved row", async ({ page }) => {
  const word = tag();
  const s = await channel(page, word, [`memo at save ${word}`]);
  await open(page, `#/c/${s.room}`);
  const post = postRow(page, s.posts[0]!);
  await post.hover();
  await post.locator("[data-save-later]").click();
  const toast = page.locator(".toast").filter({ hasText: "Saved" });
  await toast.getByRole("button", { name: "Add memo" }).click();
  const field = page.locator("[data-memo-field]");
  await expect(field).toBeFocused();
  const prompt = page.getByRole("dialog", { name: "Memo for this saved message" });
  await expect(prompt.locator("[data-memo-title]")).toHaveText("Memo for this saved message");
  const promptBox = (await prompt.boundingBox())!;
  const composerBox = (await page.locator("[data-composer]").first().boundingBox())!;
  expect(promptBox.y + promptBox.height).toBeLessThanOrEqual(composerBox.y);
  await field.fill(`call the vendor ${word}`);
  await page.keyboard.press("Enter");
  await expect(field).toHaveCount(0);
  await expect.poll(() => memoOf(page, s.ids[0]!)).toBe(`call the vendor ${word}`);

  await open(page, "#/c/saved", "later-page");
  await expect(page.locator(`[data-later-id="${s.ids[0]}"] [data-later-memo]`)).toHaveText(`call the vendor ${word}`);
});

test("a row's memo is added from More actions, edited by a click, kept over a reload, and a blank memo removes it", async ({ page }) => {
  const word = tag();
  const s = await channel(page, word, [`memo edit ${word}`]);
  await save(page, s);
  const id = s.ids[0]!;
  await open(page, "#/c/saved", "later-page");
  const row = page.locator(`[data-later-id="${id}"]`);
  await row.hover();
  await row.locator("[data-later-more]").click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Add memo" }).click();
  const field = row.locator("[data-memo-field]");
  await expect(field).toBeFocused();
  await field.fill(`first ${word}`);
  await page.keyboard.press("Enter");
  await expect(row.locator("[data-later-memo]")).toHaveText(`first ${word}`);
  await expect.poll(() => memoOf(page, id)).toBe(`first ${word}`);

  await page.reload();
  await expect(row.locator("[data-later-memo]")).toHaveText(`first ${word}`);
  const shown = (await row.locator("[data-later-memo]").boundingBox())!;
  const rowHeight = (await row.boundingBox())!.height;
  await row.locator("[data-later-memo]").click();
  await expect(field).toHaveValue(`first ${word}`);
  const editing = (await field.boundingBox())!;
  expect(Math.abs(editing.y - shown.y)).toBeLessThan(1);
  expect(Math.abs(editing.height - shown.height)).toBeLessThan(1);
  expect(Math.abs((await row.boundingBox())!.height - rowHeight)).toBeLessThan(1);
  await field.fill(`second ${word}`);
  await page.keyboard.press("Escape");
  await expect(row.locator("[data-later-memo]")).toHaveText(`first ${word}`);

  await row.locator("[data-later-memo]").click();
  await field.fill(`second ${word}`);
  await page.getByRole("heading", { name: "Saved" }).click();
  await expect(row.locator("[data-later-memo]")).toHaveText(`second ${word}`);
  await expect.poll(() => memoOf(page, id)).toBe(`second ${word}`);

  await row.hover();
  await row.locator("[data-later-memo-edit]").click();
  await field.fill("   ");
  await page.keyboard.press("Enter");
  await expect(row.locator("[data-later-memo]")).toHaveCount(0);
  await expect.poll(() => memoOf(page, id)).toBeUndefined();
});

test("the search finds an item by a word only in its memo, keeps it over a reload, and arrow down reaches the row without acting on it", async ({ page }) => {
  const word = tag();
  const s = await channel(page, word, [`plain post ${word}`, "another post"]);
  await save(page, s);
  await page.request.patch(`/api/later/${encodeURIComponent(s.ids[1]!)}`, { data: { memo: `zebra${word}` } });
  await open(page, "#/c/saved", "later-page");
  const search = page.locator("[data-saved-search]");
  await search.fill(`zebra${word}`);
  await expect(page).toHaveURL(new RegExp(`q=zebra${word}`));
  await expect(page.locator("[data-later-id]")).toHaveCount(1);
  await expect(page.locator(`[data-later-id="${s.ids[1]}"]`)).toBeVisible();
  await expect(tabBadge(page, "In progress")).toHaveText(/In progress\s*1/);

  await page.reload();
  await expect(search).toHaveValue(`zebra${word}`);
  await expect(page.locator("[data-later-id]")).toHaveCount(1);
  await search.focus();
  await page.keyboard.type("e");
  await expect(page.locator("[data-later-id]")).toHaveCount(0);
  await expect(page.locator("[data-saved-clear]")).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowRight");
  const ring = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(await ring("[data-saved-search]")).toBe("none");
  expect(await ring("[data-saved-filters] .search .inline")).toBe("solid");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(`[data-later-id="${s.ids[1]}"] a[data-later-open]`)).toBeFocused();
  expect(await ring(`[data-later-id="${s.ids[1]}"] a[data-later-open]`)).toBe("none");
  expect(await ring(`[data-later-id="${s.ids[1]}"]`)).toBe("solid");
  await page.locator("[data-saved-search]").focus();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/q=/);
});

test("Kind and In narrow the list and each tab's count, and Clear filters brings everything back", async ({ page }) => {
  const word = tag();
  const a = await channel(page, word, [`kind ${word} one`, `kind ${word} two`]);
  const b = await channel(page, word, [`kind ${word} three`]);
  await save(page, a);
  await save(page, b);
  await page.request.patch(`/api/later/${encodeURIComponent(a.ids[1]!)}`, { data: { state: "archived" } });
  const note = ((await (await page.request.post("/api/later", { data: { note: `kind ${word} reminder` } })).json()) as { item: { id: string } }).item.id;
  const pageNote = ((await (await page.request.post("/api/later", { data: { note: `[kind ${word} page](wiki:sessions/kind-${word}.html)` } })).json()) as { item: { id: string } }).item.id;

  await open(page, `#/c/saved?q=${encodeURIComponent(`kind ${word}`)}`, "later-page");
  const rows = page.locator("[data-later-id]");
  await expect(rows).toHaveCount(4);
  await expect(tabBadge(page, "In progress")).toHaveText(/In progress\s*4/);
  await expect(tabBadge(page, "Archived")).toHaveText(/Archived\s*1/);

  await page.locator("[data-saved-filters]").getByRole("button", { name: "Kind" }).click();
  await page.getByRole("menu", { name: "Kind" }).getByRole("menuitemradio", { name: "Reminders" }).click();
  await expect(page).toHaveURL(/kind=reminder/);
  await expect(rows).toHaveCount(1);
  await expect(page.locator(`[data-later-id="${note}"]`)).toBeVisible();
  await expect(tabBadge(page, "In progress")).toHaveText(/In progress\s*1/);
  await expect(tabBadge(page, "Archived")).toHaveText(/^\s*Archived\s*$/);

  await page.locator("[data-saved-filters]").getByRole("button", { name: "Reminders" }).click();
  await page.getByRole("menu", { name: "Kind" }).getByRole("menuitemradio", { name: "Wiki pages" }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator(`[data-later-id="${pageNote}"]`)).toBeVisible();

  await page.getByRole("button", { name: "Remove the Kind filter" }).click();
  await page.locator("[data-saved-filters]").getByRole("button", { name: "In", exact: true }).click();
  await page.getByRole("option", { name: a.name }).click();
  await expect(page).toHaveURL(new RegExp(`in=${a.room}`));
  await expect(rows).toHaveCount(1);
  await expect(page.locator(`[data-later-id="${a.ids[0]}"]`)).toBeVisible();
  await expect(tabBadge(page, "Archived")).toHaveText(/Archived\s*1/);
  await page.getByRole("tab", { name: /Archived/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/saved/archived\\?.*in=${a.room}`));
  await expect(page.locator(`[data-later-id="${a.ids[1]}"]`)).toBeVisible();
  await page.getByRole("tab", { name: /Completed/ }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("later-page").getByRole("status")).toContainText("1 match in In progress and 1 in Archived.");
  await page.locator('[data-saved-other-tab="archived"]').click();
  await expect(page).toHaveURL(new RegExp(`#/c/saved/archived\\?.*in=${a.room}`));
  await expect(page.locator(`[data-later-id="${a.ids[1]}"]`)).toBeVisible();

  await page.locator("[data-saved-search]").fill(`nothing${word}`);
  await expect(rows).toHaveCount(0);
  await page.locator("[data-saved-clear]").click();
  await expect(page).not.toHaveURL(/[?&](q|in|kind)=/);
  await expect(page.locator(`[data-later-id="${a.ids[1]}"]`)).toBeVisible();
});

test("a saved DM post says Direct message on its room line, and Remind me shows its M key on the right", async ({ page }) => {
  const word = tag();
  const post = ((await (await page.request.post("/api/c/dm_vent/send", { data: { text: `dm save ${word}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id;
  await page.request.post("/api/later", { data: { room: "dm_vent", post } });
  await open(page, `#/c/saved?q=${encodeURIComponent(`dm save ${word}`)}`, "later-page");
  const row = page.locator(`[data-later-id="dm_vent:${post}"]`);
  await expect(row.locator("[data-later-room]")).toHaveText("Direct message");
  await row.hover();
  await row.locator("[data-later-more]").click();
  const remind = page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: /Remind me/ });
  await expect(remind.locator("kbd")).toHaveText("M");
  const label = (await remind.locator(".label").boundingBox())!;
  const key = (await remind.locator("kbd").boundingBox())!;
  expect(key.x).toBeGreaterThan(label.x + label.width);
  expect(Math.abs(key.y + key.height / 2 - (label.y + label.height / 2))).toBeLessThan(3);
  await page.keyboard.press("Escape");
  await page.request.delete(`/api/later/${encodeURIComponent(`dm_vent:${post}`)}`);
});

test("an old #/c/later link lands on Saved with its tab and query", async ({ page }) => {
  await page.goto("/#/c/later/archived?q=old");
  await expect(page).toHaveURL(/#\/c\/saved\/archived\?q=old$/);
  await expect(page.getByTestId("later-page").getByRole("heading", { name: "Saved" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Archived/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-saved-search]")).toHaveValue("old");
});

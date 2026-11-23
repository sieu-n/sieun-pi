import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers.ts";

/**
 * Saved's rows as Slack's Later list has them: a More actions menu, an Archived tab between In progress and Completed, the channel name as
 * its own link, and a keyboard path where the arrow keys move between rows and the menu's letters act on the focused one. Each run makes
 * its own channel on the fixture server.
 */
async function saved(page: Page, count: number): Promise<{ room: string; name: string; ids: string[] }> {
  const name = `later-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const sent = (await (await page.request.post(`/api/c/${room}/send`, { data: { text: `${name} post ${n}`, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
    await page.request.post("/api/later", { data: { room, post: sent.item.id } });
    ids.push(`${room}:${sent.item.id}`);
  }
  return { room, name, ids };
}

// Each test saves posts that land on top of the one shared Saved list, so they run one at a time.
test.describe.configure({ mode: "serial" });

type Item = { id: string; state: string };
const stateOf = async (page: Page, id: string): Promise<string | undefined> =>
  ((await (await page.request.get("/api/later")).json()) as { items: Item[] }).items.find((i) => i.id === id)?.state;

test("a row's More actions menu archives it, Archived lists it, and Undo brings it back", async ({ page }) => {
  const { ids } = await saved(page, 1);
  const id = ids[0]!;
  await open(page, "#/c/saved", "later-page");
  await expect(page.getByTestId("later-page").getByRole("tab")).toHaveText([/In progress/, "Archived", "Completed"]);
  const row = page.locator(`[data-later-id="${id}"]`);
  await row.hover();
  await row.locator("[data-later-more]").click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu.getByRole("menuitem")).toHaveText([/Open message/, /Go to #later-/, /Mark complete/, /Archive/, /Remind me/, /Add memo/, /Mark unread/, /Copy link/, /Remove from Saved/]);
  await menu.getByRole("menuitem", { name: /Archive/ }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => stateOf(page, id)).toBe("archived");

  await page.getByRole("tab", { name: "Archived" }).click();
  await expect(page).toHaveURL(/#\/c\/saved\/archived$/);
  await expect(row).toBeVisible();
  await page.locator(".toast").filter({ hasText: "Archived" }).getByRole("button", { name: "Undo" }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => stateOf(page, id)).toBe("open");
});

test("arrow keys move between rows, E archives the focused row, and focus lands on the next one", async ({ page }) => {
  const { ids } = await saved(page, 3);
  await open(page, "#/c/saved", "later-page");
  const link = (id: string) => page.locator(`[data-later-id="${id}"] a[data-later-open]`);
  const focused = () => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-later-id]")?.dataset.laterId);
  await link(ids[2]!).focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe(ids[1]);
  await page.keyboard.press("ArrowUp");
  await expect.poll(focused).toBe(ids[2]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("e");
  await expect(page.locator(`[data-later-id="${ids[1]}"]`)).toHaveCount(0);
  await expect.poll(() => stateOf(page, ids[1]!)).toBe("archived");
  await expect.poll(focused).toBe(ids[0]);
  await page.keyboard.press("c");
  await expect.poll(() => stateOf(page, ids[0]!)).toBe("done");
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the channel name on a row opens the channel", async ({ page }) => {
  const { room, name, ids } = await saved(page, 1);
  await open(page, "#/c/saved", "later-page");
  await page.locator(`[data-later-id="${ids[0]}"] [data-later-room]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${room}$`));
  await expect(page.locator("section.conversation")).toContainText(`${name} post 1`);
});

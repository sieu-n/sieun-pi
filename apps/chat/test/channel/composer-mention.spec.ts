import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open } from "./helpers";

/** The @ card the composer opens, found by its listbox so a closed card reads as zero. */
const card = (page: Page) => page.getByRole("listbox");

async function typeMention(page: Page, text: string) {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(text);
  await expect(page.getByRole("option", { name: /^Crawler VP/ })).toBeVisible();
  return input;
}

async function sendAndRead(page: Page) {
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`) && r.method() === "POST");
  await page.keyboard.press("Enter");
  return (await sent).postDataJSON() as { text: string; mentions: string[] };
}

for (const key of ["Enter", "Tab"] as const) {
  test(`${key} on the @ card inserts the mention once, closes the card, and the next Enter sends it`, async ({ page }) => {
    const input = await typeMention(page, "@crawl");
    await page.keyboard.press(key);
    await expect(input.locator("[data-chip-id]")).toHaveCount(1);
    await expect(input.locator("[data-chip-id]")).toHaveText("@Crawler VP");
    await expect(card(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
    await expect(input).toBeFocused();
    const body = await sendAndRead(page);
    expect(body.text).toBe("@Crawler VP");
    expect(body.mentions).toHaveLength(1);
  });
}

test("a click on the @ card inserts the mention once, keeps the caret in the composer and closes the card", async ({ page }) => {
  const input = await typeMention(page, "hi @crawl");
  await page.getByRole("option", { name: /^Crawler VP/ }).click();
  await expect(input.locator("[data-chip-id]")).toHaveCount(1);
  await expect(card(page)).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.type("go");
  await expect(input).toHaveText("hi @Crawler VP\u00a0go");
  await expect(card(page)).toHaveCount(0);
});

test("Escape closes the @ card and it stays closed while the same query goes on", async ({ page }) => {
  const input = await typeMention(page, "@crawl");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.type("e");
  await expect(card(page)).toHaveCount(0);
  await expect(input.locator("[data-chip-id]")).toHaveCount(0);
  const body = await sendAndRead(page);
  expect(body.text).toBe("@crawle");
  expect(body.mentions).toEqual([]);
});

test("a new @ after a dismissed one opens the card again, and arrows pick the next row", async ({ page }) => {
  const input = await typeMention(page, "@crawl");
  await page.keyboard.press("Escape");
  await page.keyboard.type(" and @");
  await expect(card(page)).toHaveCount(1);
  const first = await page.getByRole("option").first().textContent();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input.locator("[data-chip-id]")).toHaveCount(1);
  await expect(input.locator("[data-chip-id]")).not.toHaveText(`@${first?.trim()}`);
  await expect(card(page)).toHaveCount(0);
});

test("two mentions in a row each insert once and the send carries both", async ({ page }) => {
  const input = await typeMention(page, "@crawl");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@ven");
  await expect(page.getByRole("option", { name: /^Vent/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(input.locator("[data-chip-id]")).toHaveCount(2);
  await expect(card(page)).toHaveCount(0);
  const body = await sendAndRead(page);
  expect(body.text).toBe("@Crawler VP @Vent");
  expect(body.mentions).toHaveLength(2);
});

test("moving the caret back into a typed @query reopens the card, and moving out closes it", async ({ page }) => {
  const input = await typeMention(page, "@crawl");
  await page.keyboard.type(" x");
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("option", { name: /^Crawler VP/ })).toBeVisible();
  await page.keyboard.press("End");
  await expect(card(page)).toHaveCount(0);
  await expect(input.locator("[data-chip-id]")).toHaveCount(0);
});

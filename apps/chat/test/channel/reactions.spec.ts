import { expect, test, type Page } from "@playwright/test";
import { open, row } from "./helpers.ts";

/** Vent's DM in the fixture (server/fixture/seed.ts): p10 is Vent's answer, which these specs dress with reactions. */
const DM = "dm_vent";
const vent = { id: "ag_vent", kind: "chat", name: "vent", avatar: { initials: "Ve", hue: 120 } };
const factory = { id: "ag_agent-factory", kind: "chat", name: "agent factory", avatar: { initials: "Af", hue: 40 } };
const owner = { id: "owner", kind: "owner", name: "Sieun", avatar: { initials: "Me", hue: 210 } };
const REACTIONS = [
  { emoji: "👀", by: [vent, factory, owner] },
  { emoji: "⏳", by: [vent] },
];

type Json = Record<string, unknown>;

/** Serves p10 with `reactions` and records each reaction the owner posts, answered with the post as the server would. */
async function dressed(page: Page): Promise<{ posted: Json[] }> {
  const posted: Json[] = [];
  await page.route(`**/api/c/${DM}/items*`, async (route) => {
    const body = (await (await route.fetch()).json()) as { items: Json[] };
    await route.fulfill({ json: { ...body, items: body.items.map((item) => (item.id === "p10" ? { ...item, reactions: REACTIONS } : item)) } });
  });
  await page.route(`**/api/c/${DM}/posts/p10/reactions`, async (route) => {
    posted.push(route.request().postDataJSON() as Json);
    await route.fulfill({ json: { item: { id: "p10" } } });
  });
  await page.addInitScript(() => localStorage.removeItem("chat.emoji.frequent"));
  await open(page, `#/c/${DM}`);
  return { posted };
}

test("chips show the emoji and its count, the owner's own is highlighted, and an ⏳ is a chip like any other", async ({ page }) => {
  await dressed(page);
  const post = row(page, "p10");
  const eyes = post.locator('[data-reaction="👀"]');
  await expect(eyes).toHaveText("👀3");
  await expect(eyes).toHaveAttribute("aria-pressed", "true");
  const hourglass = post.locator('[data-reaction="⏳"]');
  await expect(hourglass).toHaveText("⏳1");
  await expect(hourglass).toHaveAttribute("aria-pressed", "false");
  await expect(hourglass).toHaveAccessibleName("vent reacted with :hourglass_flowing_sand:");
  await expect(page.getByText("working on this")).toHaveCount(0);
  expect(await eyes.evaluate((el) => el.getBoundingClientRect().height)).toBe(24);
});

test("the add-reaction chip and the one-click emoji show only on hover", async ({ page }) => {
  await dressed(page);
  const post = row(page, "p10");
  const add = post.locator("[data-add-reaction-chip]");
  await page.mouse.move(0, 0);
  await expect(add).toHaveCSS("opacity", "0");
  await post.hover();
  await expect(add).toHaveCSS("opacity", "1");
  await expect(post.locator("[data-quick-reaction]")).toHaveCount(3);
  await expect(post.locator("[data-quick-reaction]").first()).toHaveAttribute("data-quick-reaction", "✅");
});

test("the hover card names who reacted with the owner as You and shows the emoji's name", async ({ page }) => {
  await dressed(page);
  await row(page, "p10").locator('[data-reaction="👀"]').hover();
  const card = page.locator("[data-reaction-card]");
  await expect(card).toBeVisible();
  await expect(card).toHaveText(/👀\s*You, vent and agent factory reacted with :eyes:/);
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
});

test("a click on a chip toggles the owner's own reaction", async ({ page }) => {
  const { posted } = await dressed(page);
  const post = row(page, "p10");
  await post.locator('[data-reaction="👀"]').click();
  await post.locator('[data-reaction="⏳"]').click();
  await expect.poll(() => posted).toEqual([{ emoji: "👀", on: false }, { emoji: "⏳", on: true }]);
});

test("the picker searches, moves by arrows, picks with Enter, keeps Frequently used and closes on Esc", async ({ page }) => {
  const { posted } = await dressed(page);
  const post = row(page, "p10");
  await post.hover();
  await post.locator("[data-add-reaction]").click();
  const picker = page.locator("[data-emoji-picker]");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".head").first()).toHaveText("Frequently used");
  await expect(picker.getByRole("tab")).toHaveCount(10);
  await expect(picker.locator('[data-emoji="👀"]').first()).toHaveClass(/mine/);

  await page.keyboard.type("rocket");
  await expect(picker.locator(".head")).toHaveText("Search results");
  await expect(picker.locator(".footer")).toContainText(":rocket:");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect.poll(() => posted).toEqual([{ emoji: "🚀", on: true }]);

  await post.hover();
  await post.locator("[data-add-reaction]").click();
  await expect(picker.locator(".row").first().locator("[data-emoji]").first()).toHaveAttribute("data-emoji", "🚀");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const second = await picker.locator(".row").nth(1).locator("[data-emoji]").nth(1).getAttribute("data-emoji");
  await expect(picker.locator(".cell.active")).toHaveAttribute("data-emoji", second!);
  await picker.locator('[data-emoji="🎉"]').first().hover();
  await expect(picker.locator(".footer")).toContainText(":tada:");

  await picker.getByRole("tab", { name: "Flags" }).click();
  await expect(picker.getByRole("tab", { name: "Flags" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("zzzz");
  await expect(picker).toContainText("No emoji match");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";
import { tag } from "../channel/helpers.ts";

// A channel's and a section's emoji icon, picked as Notion picks a page icon: click the icon spot or the menu's Add emoji, pick, or Remove.
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const row = (page: Page, room: string) => sidebar(page).locator(`a[href="#/c/${room}"]`).first();
const picker = (page: Page, label: string) => page.getByRole("dialog", { name: label });

async function pick(page: Page, label: string, query: string, emoji: string) {
  const dialog = picker(page, label);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Search emoji" }).fill(query);
  await dialog.locator(`[data-emoji="${emoji}"]`).first().click();
  await expect(dialog).toHaveCount(0);
}

test("a channel's emoji replaces its # in the sidebar and the header, stays after a reload, and Remove brings the # back", async ({ page }) => {
  const name = `emoji-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  try {
    await page.goto("/#/c/ch_general");
    const channel = row(page, room);
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await expect(channel.locator(".lead svg")).toHaveCount(1);

    // A click on the icon spot opens the picker and leaves the open room as it was.
    await channel.hover();
    await channel.locator("[data-row-icon]").click();
    await pick(page, `Emoji for #${name}`, "rocket", "🚀");
    expect(page.url()).toContain("#/c/ch_general");
    await expect(channel.locator(".lead")).toHaveText("🚀");
    await expect(channel.locator(".lead svg")).toHaveCount(0);
    await expect(channel).toHaveAccessibleName(name);

    await channel.click();
    const title = page.getByTestId("channel-title-button");
    await expect(title).toContainText("🚀");
    await expect(page.locator(".conversation .panel-header > .icon")).toHaveCount(0);

    await page.reload();
    await expect(row(page, room).locator(".lead")).toHaveText("🚀", { timeout: 15_000 });
    await expect(page.getByTestId("channel-title-button")).toContainText("🚀");

    // The row's menu changes it and removes it, the keyboard's way to the same picker.
    await row(page, room).hover();
    await sidebar(page).getByRole("button", { name: `${name} options` }).click();
    await page.getByRole("menuitem", { name: "Change emoji" }).click();
    await picker(page, `Emoji for #${name}`).getByRole("button", { name: "Remove" }).click();
    await expect(row(page, room).locator(".lead svg")).toHaveCount(1);
    await expect(page.getByTestId("channel-title-button")).not.toContainText("🚀");
    await expect(page.locator(".conversation .panel-header > .icon")).toHaveCount(1);
  } finally {
    await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
  }
});

test("a walk's open test room shows its picked emoji at once in the row and the header, with no live event", async ({ page }) => {
  const name = `emoji-test-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string }).id;
  try {
    await page.goto(`/#/c/${room}`);
    const channel = row(page, room);
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await channel.hover();
    await channel.locator("[data-row-icon]").click();
    await pick(page, `Emoji for #${name}`, "rocket", "🚀");
    await expect(channel.locator(".lead")).toHaveText("🚀");
    await expect(page.getByTestId("channel-title-button")).toContainText("🚀");
  } finally {
    await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
  }
});

test("a section's emoji shows before its name, stays after a reload, and Remove takes it off", async ({ page }) => {
  const name = `Emoji ${tag()}`;
  await page.goto("/#/c/ch_general");
  await expect(row(page, "ch_general")).toBeVisible({ timeout: 15_000 });
  await sidebar(page).locator('[data-section-id="channels"]').getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create section" }).click();
  const section = sidebar(page).locator("[data-section-id^=sec_]").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(section).toBeVisible();

  const heading = section.getByRole("heading", { name, exact: true });
  const menu = async (item: string) => {
    await heading.hover();
    await sidebar(page).getByRole("button", { name: `${name} options` }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  try {
    await expect(section.locator("[data-section-icon]")).toHaveCount(0);
    await menu("Add emoji");
    await pick(page, `Emoji for ${name}`, "books", "📚");
    await expect(section.locator("[data-section-icon]")).toHaveText("📚");
    await expect(section.locator("button[data-fold]")).toHaveAccessibleName(name);

    await page.reload();
    await expect(section.locator("[data-section-icon]")).toHaveText("📚", { timeout: 15_000 });
    const folded = await section.locator("button[data-fold]").getAttribute("aria-expanded");

    // A click on the emoji opens the picker again and does not fold the section.
    await section.locator("[data-section-icon]").click();
    await expect(section.locator("button[data-fold]")).toHaveAttribute("aria-expanded", folded!);
    await picker(page, `Emoji for ${name}`).getByRole("button", { name: "Remove" }).click();
    await expect(section.locator("[data-section-icon]")).toHaveCount(0);
  } finally {
    await menu("Delete section");
    await expect(section).toHaveCount(0);
  }
});

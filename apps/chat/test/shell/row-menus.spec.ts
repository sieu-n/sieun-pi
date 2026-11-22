import { expect, test, type Page } from "@playwright/test";

/** Sidebar row menus as Slack has them: Star, Mute, Leave channel and Archive channel on a channel, Close conversation on a DM, with Undo. */
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const row = (page: Page, id: string) => sidebar(page).locator(`a[href="#/c/${id}"]`);
const starredBlock = (page: Page) => sidebar(page).locator('[data-section="starred"]');

async function openMenu(page: Page, id: string, name: string) {
  await row(page, id).hover();
  await sidebar(page).getByRole("button", { name: `${name} options` }).first().click();
}

async function pick(page: Page, id: string, name: string, item: string) {
  await openMenu(page, id, name);
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("a channel stars, mutes, leaves and archives from its row menu, and Undo brings it back", async ({ page }) => {
  test.slow();
  const name = `rowmenu-${Date.now().toString(36)}`;
  const made = await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } });
  expect(made.ok()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  try {
    await page.goto("/#/c/ch_general");
    await expect(row(page, id)).toBeVisible({ timeout: 15_000 });

    await openMenu(page, id, name);
    const menu = page.getByRole("menu");
    for (const item of ["Mark as read", "Copy link", "Star channel", "Mute channel", "Rename channel", "Move to", "Leave channel", "Archive channel"]) {
      await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: "Mark as read" })).toBeDisabled();
    await page.keyboard.press("Escape");

    await pick(page, id, name, "Star channel");
    await expect(starredBlock(page).locator(`a[href="#/c/${id}"]`)).toBeVisible();
    await expect(row(page, id)).toHaveCount(1);
    await pick(page, id, name, "Mute channel");
    await expect(row(page, id)).toHaveClass(/muted/);
    await openMenu(page, id, name);
    await expect(page.getByRole("menuitem", { name: "Unstar channel" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unmute channel" })).toBeVisible();
    await page.keyboard.press("Escape");

    await pick(page, id, name, "Leave channel");
    await expect(row(page, id)).toHaveCount(0);
    const left = page.getByText(`You left #${name}`);
    await expect(left).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(row(page, id)).toBeVisible();

    await pick(page, id, name, "Archive channel");
    await expect(row(page, id)).toHaveCount(0);
    await expect(page.getByText(`Archived #${name}`)).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(row(page, id)).toBeVisible();
    await expect(page.getByText(`Unarchived #${name}`)).toBeVisible();
  } finally {
    await page.request.patch(`/api/rooms/${id}`, { data: { archived: true } });
  }
});

test("a test room's row shows while it is open, takes its menu, and leaves the sidebar when another room opens", async ({ page }) => {
  const name = `rowmenu-test-${Date.now().toString(36)}`;
  const made = await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } });
  expect(made.ok()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  try {
    await page.goto(`/#/c/${id}`);
    await expect(row(page, id)).toBeVisible({ timeout: 15_000 });
    await pick(page, id, name, "Star channel");
    await expect(starredBlock(page).locator(`a[href="#/c/${id}"]`)).toBeVisible();
    await page.goto("/#/c/ch_general");
    await expect(row(page, "ch_general")).toBeVisible();
    await expect(row(page, id)).toHaveCount(0);
  } finally {
    await page.request.patch(`/api/rooms/${id}`, { data: { archived: true } });
  }
});

test("Close conversation takes the open DM out of the sidebar and off the page, and Undo puts it back", async ({ page }) => {
  const id = "dm_crawler-vp";
  await page.goto(`/#/c/${id}`);
  await expect(row(page, id)).toBeVisible({ timeout: 15_000 });
  const name = (await row(page, id).innerText()).trim().split("\n")[0]!;
  await openMenu(page, id, name);
  for (const item of ["Star conversation", "Mute conversation", "Open agent", "Close conversation"]) {
    await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Close conversation" }).click();
  try {
    await expect(row(page, id)).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(`/c/${id}`));
    await expect(page.getByText(`Closed your conversation with ${name}`)).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(row(page, id)).toBeVisible();
  } finally {
    await page.request.put(`/api/c/${id}/prefs`, { data: { hidden: null } });
  }
});

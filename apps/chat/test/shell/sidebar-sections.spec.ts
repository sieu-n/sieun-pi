import { expect, test, type Page } from "@playwright/test";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const block = (page: Page, id: string) => sidebar(page).locator(`[data-section-id="${id}"]`);
const section = (page: Page, name: string) => sidebar(page).locator("[data-section-id^=sec_]").filter({ has: page.getByRole("heading", { name, exact: true }) });
const fold = (page: Page, name: string) => sidebar(page).getByRole("button", { name, exact: true });
const IDS: Record<string, string> = { general: "ch_general", "pi-cutover": "ch_cutover", vent: "dm_vent" };
const link = (name: string) => `a[href="#/c/${IDS[name]}"]`;
const channel = (page: Page, name: string) => sidebar(page).locator(link(name));

async function rowMenu(page: Page, name: string) {
  await channel(page, name).hover();
  await sidebar(page).getByRole("button", { name: `${name} options` }).click();
}

async function nameSection(page: Page, title: string, name: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: title === "Rename section" ? "Save" : "Create section" }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(channel(page, "general")).toBeVisible({ timeout: 15_000 });
});

test("a section takes channels by menu and drag, renames, folds with the built-in sections, survives a reload and gives its channels back", async ({ page }) => {
  test.slow();
  await block(page, "channels").getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByRole("button", { name: "Create section" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the section a name");
  await nameSection(page, "New section", "Projects");
  await expect(section(page, "Projects")).toBeVisible();

  await rowMenu(page, "general");
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitemradio", { name: "Projects" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(section(page, "Projects").locator(link("general"))).toBeVisible();

  await channel(page, "pi-cutover").dragTo(section(page, "Projects").getByRole("heading", { name: "Projects" }));
  await expect(section(page, "Projects").locator(link("pi-cutover"))).toBeVisible();
  for (const name of ["general", "pi-cutover"]) await expect(block(page, "channels").locator(link(name))).toHaveCount(0);

  await section(page, "Projects").getByRole("heading", { name: "Projects" }).hover();
  await sidebar(page).getByRole("button", { name: "Projects options" }).click();
  await page.getByRole("menuitem", { name: "Rename section" }).click();
  await expect(page.getByRole("dialog", { name: "Rename section" }).getByLabel("Name", { exact: true })).toHaveValue("Projects");
  await nameSection(page, "Rename section", "Work");
  await expect(section(page, "Work")).toBeVisible();

  await page.goto("/#/c/dm_vent");
  await expect(channel(page, "vent")).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  for (const name of ["Work", "Channels", "Direct messages"]) {
    await fold(page, name).click();
    await expect(fold(page, name)).toHaveAttribute("aria-expanded", "false");
  }
  await expect(section(page, "Work").getByRole("link")).toHaveCount(0);
  const dms = sidebar(page).locator('[data-section="team"] a[href^="#/c/dm_"]');
  await expect(dms).toHaveCount(1);
  await expect(dms).toHaveAttribute("href", "#/c/dm_vent");

  await page.reload();
  await expect(section(page, "Work")).toBeVisible({ timeout: 15_000 });
  for (const name of ["Work", "Channels", "Direct messages"]) await expect(fold(page, name)).toHaveAttribute("aria-expanded", "false");
  await expect(section(page, "Work").getByRole("link")).toHaveCount(0);
  await expect(dms).toHaveCount(1);

  await page.goto("/#/c/ch_general");
  await expect(section(page, "Work").locator(link("general"))).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  await expect(section(page, "Work").getByRole("link")).toHaveCount(1);

  await section(page, "Work").getByRole("heading", { name: "Work" }).hover();
  await sidebar(page).getByRole("button", { name: "Work options" }).click();
  await page.getByRole("menuitem", { name: "Delete section" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Work?" });
  await expect(confirm).toContainText("Its 2 channels move back to Channels.");
  await confirm.getByRole("button", { name: "Delete section" }).click();
  await expect(section(page, "Work")).toHaveCount(0);
  await fold(page, "Channels").click();
  await expect(block(page, "channels").locator(link("general"))).toBeVisible();
  await expect(block(page, "channels").locator(link("pi-cutover"))).toBeVisible();
});

test("the row's context menu renames the channel, makes a section for it, refuses a duplicate name and deletes an empty section at once", async ({ page }) => {
  await channel(page, "general").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename channel" }).click();
  const rename = page.getByRole("dialog", { name: "Rename channel" });
  await expect(rename).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);

  await channel(page, "pi-cutover").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  await nameSection(page, "New section", "Ops");
  await expect(section(page, "Ops").locator(link("pi-cutover"))).toBeVisible();

  await channel(page, "general").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill(" ops ");
  await dialog.getByRole("button", { name: "Create section" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A section with this name already exists");
  await nameSection(page, "New section", "Later");

  await channel(page, "general").dragTo(block(page, "channels").getByRole("heading", { name: "Channels" }));
  await expect(block(page, "channels").locator(link("general"))).toBeVisible();
  await section(page, "Later").getByRole("heading", { name: "Later" }).hover();
  await sidebar(page).getByRole("button", { name: "Later options" }).click();
  await page.getByRole("menuitem", { name: "Delete section" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(section(page, "Later")).toHaveCount(0);
  await expect(section(page, "Ops")).toBeVisible();
});

test("a bad saved value or a placement naming a missing section leaves the channels under Channels", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem(
      "chat.sidebarSections",
      JSON.stringify({ sections: [{ id: "sec_a", name: "Kept" }, { id: 3 }, { id: "sec_b", name: " " }], placement: { ch_general: "sec_gone", ch_missing: "sec_a" }, collapsed: { dms: "yes" } }),
    ),
  );
  await page.reload();
  await expect(section(page, "Kept")).toBeVisible({ timeout: 15_000 });
  await expect(sidebar(page).locator("[data-section-id^=sec_]")).toHaveCount(1);
  await expect(block(page, "channels").locator(link("general"))).toBeVisible();
  await expect(fold(page, "Direct messages")).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => localStorage.setItem("chat.sidebarSections", "{not json"));
  await page.reload();
  await expect(block(page, "channels").locator(link("general"))).toBeVisible({ timeout: 15_000 });
});

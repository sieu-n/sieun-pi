import { expect, test, type Page } from "@playwright/test";

// The layout lives on the one fixture server, so these tests take turns and leave it empty.
test.describe.configure({ mode: "serial" });
const resetLayout = (page: Page) => page.request.put("/api/sidebar/layout", { data: {} });

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const block = (page: Page, id: string) => sidebar(page).locator(`[data-section-id="${id}"]`);
const section = (page: Page, name: string) => sidebar(page).locator("[data-section-id^=sec_]").filter({ has: page.getByRole("heading", { name, exact: true }) });
const fold = (page: Page, name: string) => sidebar(page).getByRole("button", { name, exact: true });
const IDS: Record<string, string> = { general: "ch_general", "pi-cutover": "ch_cutover", vent: "dm_vent", "frontend-bro": "dm_frontend-bro" };
const order = (page: Page, name: string) => section(page, name).locator("a[data-sidebar-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("href")));
const sectionNames = (page: Page) => sidebar(page).locator("[data-section-id^=sec_] [data-fold]").allInnerTexts();

async function sectionMenu(page: Page, name: string, item: string) {
  await section(page, name).getByRole("heading", { name }).hover();
  await sidebar(page).getByRole("button", { name: `${name} options` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
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

test.afterAll(async ({ request }) => {
  await request.put("/api/sidebar/layout", { data: {} });
});

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.evaluate(() => localStorage.clear());
  expect((await resetLayout(page)).ok()).toBe(true);
  await page.reload();
  await expect(channel(page, "general")).toBeVisible({ timeout: 15_000 });
});

test("a section takes channels by menu and drag, renames, folds to its open and unread rows with the built-in sections, survives a reload and gives its channels back", async ({ page }) => {
  test.slow();
  await block(page, "channels").getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByRole("button", { name: "Create section" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the section a name");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await block(page, "channels").getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  await nameSection(page, "New section", "Projects");
  await expect(section(page, "Projects")).toBeVisible();

  await rowMenu(page, "general");
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "Projects" }).click();
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
  const readWork = section(page, "Work").locator("a:not([data-unread])");
  await expect(readWork).toHaveCount(0);
  await expect(section(page, "Work").locator(link("general"))).toHaveCount(0);
  const dms = sidebar(page).locator('[data-section="dms"] a[href^="#/c/dm_"]:not([data-unread])');
  await expect(dms).toHaveCount(1);
  await expect(dms).toHaveAttribute("href", "#/c/dm_vent");
  await expect(sidebar(page).locator('[data-section="dms"] a[data-unread]').first()).toBeVisible();

  await page.reload();
  await expect(section(page, "Work")).toBeVisible({ timeout: 15_000 });
  for (const name of ["Work", "Channels", "Direct messages"]) await expect(fold(page, name)).toHaveAttribute("aria-expanded", "false");
  await expect(readWork).toHaveCount(0);
  await expect(dms).toHaveCount(1);

  await page.goto("/#/c/ch_general");
  await expect(section(page, "Work").locator(link("general"))).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  await expect(readWork).toHaveCount(1);

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

test("the server keeps only well-formed sections and placements naming one, and drops bad folds and sorts", async ({ page }) => {
  const res = await page.request.put("/api/sidebar/layout", {
    data: {
      sections: [{ id: "sec_a", name: "Kept", sort: "sideways" }, { id: 3 }, { id: "sec_b", name: " " }],
      placement: { ch_general: "sec_gone", ch_missing: "sec_a" },
      collapsed: { dms: "yes" },
      sort: { channels: "upside" },
    },
  });
  const saved = await res.json();
  expect(saved.sections).toEqual([{ id: "sec_a", name: "Kept", collapsed: false, sort: "name" }]);
  expect(saved.sort).toEqual({ channels: "name", dms: "recent" });
  await page.reload();
  await expect(section(page, "Kept")).toBeVisible({ timeout: 15_000 });
  await expect(sidebar(page).locator("[data-section-id^=sec_]")).toHaveCount(1);
  await expect(section(page, "Kept")).toContainText("Drag a channel or DM here.");
  await expect(block(page, "channels").locator(link("general"))).toBeVisible();
  await expect(fold(page, "Direct messages")).toHaveAttribute("aria-expanded", "true");
  expect((await page.request.put("/api/sidebar/layout", { data: [] })).status()).toBe(400);
});

test("a browser's old localStorage sections move to the server once, while the server has none", async ({ page }) => {
  const old = { sections: [{ id: "sec_old", name: "Old", collapsed: false }], placement: { ch_general: "sec_old" }, collapsed: {} };
  await page.evaluate((v) => localStorage.setItem("chat.sidebarSections", JSON.stringify(v)), old);
  await page.reload();
  await expect(section(page, "Old").locator(link("general"))).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("chat.sidebarSections"))).toBeNull();
  const saved = await (await page.request.get("/api/sidebar")).json();
  expect(saved.layout.placement).toEqual({ ch_general: "sec_old" });

  const late = { sections: [{ id: "sec_late", name: "Late", collapsed: false }], placement: {}, collapsed: {} };
  await page.evaluate((v) => localStorage.setItem("chat.sidebarSections", JSON.stringify(v)), late);
  await page.reload();
  await expect(section(page, "Old")).toBeVisible({ timeout: 15_000 });
  await expect(section(page, "Late")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("chat.sidebarSections"))).not.toBeNull();
});

test("a DM goes into a section, rows reorder by drag and Sort, sections reorder by drag, a second browser shows the same, and Delete has Undo", async ({ page, browser, baseURL }) => {
  test.slow();
  await block(page, "channels").getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  await nameSection(page, "New section", "Work");

  await channel(page, "vent").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await expect(page.getByRole("menuitem", { name: "Direct messages", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Work" }).click();
  await rowMenu(page, "general");
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "Work" }).click();
  await expect(block(page, "dms").locator(link("vent"))).toHaveCount(0);
  await expect.poll(() => order(page, "Work")).toEqual([`#/c/ch_general`, `#/c/dm_vent`]);

  await channel(page, "frontend-bro").dragTo(section(page, "Work").locator(link("general")), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => order(page, "Work")).toEqual([`#/c/dm_frontend-bro`, `#/c/ch_general`, `#/c/dm_vent`]);
  await channel(page, "vent").dragTo(section(page, "Work").locator(link("general")), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => order(page, "Work")).toEqual([`#/c/dm_frontend-bro`, `#/c/dm_vent`, `#/c/ch_general`]);
  await sectionMenu(page, "Work", "Sort");
  await expect(page.getByRole("menuitemradio", { name: /Custom order/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Alphabetically" }).click();
  await expect.poll(() => order(page, "Work")).toEqual([`#/c/dm_frontend-bro`, `#/c/ch_general`, `#/c/dm_vent`]);

  await block(page, "channels").getByRole("heading", { name: "Channels" }).hover();
  await sidebar(page).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  await nameSection(page, "New section", "Ops");
  await expect.poll(() => sectionNames(page)).toEqual(["Work", "Ops"]);
  await section(page, "Ops").getByRole("heading", { name: "Ops" }).dragTo(section(page, "Work").getByRole("heading", { name: "Work" }), { targetPosition: { x: 30, y: 2 } });
  await expect.poll(() => sectionNames(page)).toEqual(["Ops", "Work"]);

  const other = await browser.newContext({ baseURL });
  const second = await other.newPage();
  await second.goto("/#/c/ch_general");
  await expect.poll(() => sectionNames(second), { timeout: 15_000 }).toEqual(["Ops", "Work"]);
  await expect.poll(() => order(second, "Work")).toEqual([`#/c/dm_frontend-bro`, `#/c/ch_general`, `#/c/dm_vent`]);
  await other.close();

  await sectionMenu(page, "Work", "Delete section");
  const confirm = page.getByRole("dialog", { name: "Delete Work?" });
  await expect(confirm).toContainText("Its 3 conversations move back to Channels and Direct messages.");
  await confirm.getByRole("button", { name: "Delete section" }).click();
  await expect(section(page, "Work")).toHaveCount(0);
  await expect(block(page, "dms").locator(link("vent"))).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => order(page, "Work")).toEqual([`#/c/dm_frontend-bro`, `#/c/ch_general`, `#/c/dm_vent`]);
});

test("every row's menu copies its link and offers Mark as read only when unread, a DM's opens its agent, and Move to leaves out the channel's own section", async ({ page }) => {
  await sidebar(page).locator('[data-section="dms"] a[data-unread]').first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark as read" })).toBeVisible();
  await page.keyboard.press("Escape");
  await channel(page, "vent").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open agent" }).click();
  await expect(page).toHaveURL(/#\/agents\/ag_vent/);
  await page.goto("/#/c/ch_general");
  await expect(channel(page, "general")).not.toHaveAttribute("data-unread", /.*/, { timeout: 15_000 });

  await rowMenu(page, "general");
  await expect(page.getByRole("menuitem", { name: "Mark as read" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await expect(page.getByRole("menuitem", { name: "Channels", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "New section…" })).toBeVisible();
});

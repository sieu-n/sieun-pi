import { expect, test } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
});

test("top bar pills open each page and mark the current one", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Pages" });
  for (const [label, hash] of [
    ["Agents", "#/agents"],
    ["Board", "#/board"],
  ] as const) {
    await nav.getByRole("tab", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(nav.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
  }
  await nav.getByRole("tab", { name: "Messages" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_general$/);
});

test("the top bar holds only Messages, Agents and Board, with Usage and Hosts behind Settings", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Pages" });
  await expect(nav.getByRole("tab")).toHaveText(["Messages", "Agents", "Board"]);
  const bar = page.locator("header.topbar");
  await expect(bar.getByText("Usage")).toHaveCount(0);
  await expect(bar.getByText("Hosts")).toHaveCount(0);
});

test("the Settings button opens Settings at Usage, and its list switches to Hosts", async ({ page }) => {
  await page.locator("header.topbar").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/usage$/);
  const sections = page.getByRole("navigation", { name: "Settings" });
  await expect(sections.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await sections.getByRole("link", { name: "Hosts" }).click();
  await expect(page).toHaveURL(/#\/settings\/hosts$/);
  await expect(sections.getByRole("link", { name: "Hosts" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
});

test("the avatar menu opens Settings", async ({ page }) => {
  await page.getByRole("button", { name: "Profile, appearance and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#\/settings\/usage$/);
});

test("old #/usage and #/hosts links land in their Settings section with the query kept", async ({ page }) => {
  await page.goto("/#/usage?days=7");
  await expect(page).toHaveURL(/#\/settings\/usage\?days=7$/);
  await expect(page.getByRole("combobox", { name: "Period", exact: true })).toHaveValue("7");
  await page.goto("/#/hosts");
  await expect(page).toHaveURL(/#\/settings\/hosts$/);
  await expect(page.getByTestId("hosts-summary")).toBeVisible();
});

test("the capsule is 40 px tall and centered in a 56 px top bar", async ({ page }) => {
  const box = (await page.getByTestId("nav-capsule").boundingBox())!;
  expect(Math.round(box.height)).toBe(40);
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThanOrEqual(1);
  const bar = (await page.locator("header.topbar").boundingBox())!;
  expect(Math.round(bar.height)).toBe(56);
});

test("the + menu starts a new chat", async ({ page }) => {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: /New chat/ }).click();
  await expect(page).toHaveURL(/#\/c\/new\?kind=chat$/);
});

test("Cmd K and the search pill open search, and Esc closes it", async ({ page }) => {
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
});

test("browser back returns to the previous page", async ({ page }) => {
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_general$/);
});


test("inside the Mac app the top bar leaves room for the window buttons and drags the window, at any interface scale", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __TAURI_INTERNALS__: {} }));
  for (const scale of [null, "1.3"]) {
    await page.evaluate((value) => (value ? localStorage.setItem("chat.interfaceScale", value) : localStorage.removeItem("chat.interfaceScale")), scale);
    await page.reload();
    const bar = page.locator("header.topbar");
    await expect(bar).toHaveAttribute("data-tauri-drag-region", "deep");
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.height)).toBe(56);
    const toggle = (await bar.getByRole("button", { name: /sidebar/ }).boundingBox())!;
    expect(Math.round(toggle.x)).toBe(88);
    expect(Math.abs(toggle.y + toggle.height / 2 - 28)).toBeLessThanOrEqual(1);
  }
});

test("in a browser the top bar has no window-button room and no drag region", async ({ page }) => {
  const bar = page.locator("header.topbar");
  await expect(bar).not.toHaveAttribute("data-tauri-drag-region", /.*/);
  const toggle = (await bar.getByRole("button", { name: /sidebar/ }).boundingBox())!;
  expect(Math.round(toggle.x)).toBe(8);
});

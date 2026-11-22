import { expect, test, type Page } from "@playwright/test";
import { ownerSettings, resetOwnerSettings } from "./owner-settings";

/** Settings > Preferences, Notifications and Keyboard: this browser's own settings, read from and written to the stores the app uses. */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });

test("the Settings sidebar lists this browser's pages first and each opens at #/settings/<id>", async ({ page }) => {
  await page.goto("/#/settings/usage");
  const links = settingsNav(page).getByRole("link");
  await expect(links).toHaveText(["Preferences", "Notifications", "Keyboard", "Usage", "Hosts", "Accounts", "Skills", "Consoles"]);
  for (const [name, id] of [["Preferences", "preferences"], ["Notifications", "notifications"], ["Keyboard", "keyboard"]] as const) {
    await settingsNav(page).getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`#/settings/${id}$`));
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  }
});

test("Preferences sets the color mode and shows the exact interface size, which Cmd + and the stepper change", async ({ page }) => {
  await page.goto("/#/settings/preferences");
  const mode = page.getByLabel("Color mode");
  await mode.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  expect(await page.evaluate(() => localStorage.getItem("chat.colorMode"))).toBe("dark");
  await mode.selectOption("system");
  expect(await page.evaluate(() => localStorage.getItem("chat.colorMode"))).toBeNull();

  const size = page.getByTestId("interface-size");
  await expect(size).toHaveText("100%");
  const reset = page.getByTestId("settings-section").getByRole("button", { name: "Reset" });
  await expect(reset).toHaveCount(0);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(size).toHaveText("110%");
  await page.locator("body").press(`${mod}+=`);
  await expect(size).toHaveText("120%");
  expect(await page.evaluate(() => localStorage.getItem("chat.interfaceScale"))).toBe("1.2");
  await reset.click();
  await expect(size).toHaveText("100%");
  expect(await page.evaluate(() => localStorage.getItem("chat.interfaceScale"))).toBeNull();
});

// Two tests below write the notification setting on the one fixture server, so the tests take turns.
test.describe.configure({ mode: "serial" });
test.afterAll(({ request }) => resetOwnerSettings(request));

test("Notifications saves the setting on the server, pauses with a preset and resumes", async ({ page }) => {
  await resetOwnerSettings(page.request);
  await page.addInitScript(() => {
    class Stub {
      static permission = "granted";
      static requestPermission = async () => "granted";
      close() {}
    }
    Object.assign(window, { Notification: Stub });
  });
  await page.goto("/#/settings/notifications");
  const stored = async () => (await ownerSettings(page.request)).notify;

  await page.getByLabel("Notify me about").selectOption("all");
  await expect.poll(stored).toMatchObject({ level: "all" });
  await page.getByRole("switch", { name: "Unread count on the Dock icon and in the title" }).click();
  await expect.poll(stored).toMatchObject({ badge: false });

  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("menuitem", { name: /For 1 hour/ }).click();
  await expect(page.getByText(/^Paused until /)).toBeVisible();
  const until = (await stored()).pausedUntil as number;
  expect(Math.abs(until - Date.now() - 3_600_000)).toBeLessThan(60_000);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  expect((await stored()).pausedUntil).toBeUndefined();
});

test("Notifications says plainly when the browser blocks them", async ({ page }) => {
  await resetOwnerSettings(page.request);
  await page.addInitScript(() => {
    class Stub {
      static permission = "denied";
      static requestPermission = async () => "denied";
      close() {}
    }
    Object.assign(window, { Notification: Stub });
  });
  await page.goto("/#/settings/notifications");
  await expect(page.getByText("Blocked in this browser's settings")).toBeVisible();
  await page.getByLabel("Notify me about").selectOption("off");
  await expect(page.getByText("Blocked in this browser's settings")).toHaveCount(0);
});

test("Keyboard lists the shortcut table and filters it by name or keys", async ({ page }) => {
  await page.goto("/#/settings/keyboard");
  const list = page.getByTestId("shortcut-list");
  await expect(list.locator("[data-shortcut]").first()).toBeVisible();
  const all = await list.locator("[data-shortcut]").count();
  const search = page.getByRole("searchbox", { name: "Search shortcuts" });
  await search.fill("zoom");
  await expect(list.locator("[data-shortcut]")).toHaveCount(2);
  await search.fill("ctrl k");
  await expect(list.locator('[data-shortcut="search"]')).toBeVisible();
  await search.fill("no such key");
  await expect(page.getByText('No shortcut matches "no such key"')).toBeVisible();
  await search.fill("");
  await expect(list.locator("[data-shortcut]")).toHaveCount(all);
});

test("Consoles shows one row per console and a column per tier, with links, tunnels, TablePlus groups and read-only marks", async ({ page }) => {
  await page.goto("/#/settings/consoles");
  await expect(page.getByRole("heading", { name: "Consoles", level: 1 })).toBeVisible();
  const table = page.getByTestId("consoles-table");
  await expect(table.locator("thead th")).toHaveText(["Console", "Local dev", "Staging", "Prod"]);
  await expect(table.locator("tr[data-console] th")).toHaveText(["Postgres", "HyperDX"]);
  const postgres = table.locator('tr[data-console="postgres"]');
  await expect(postgres.locator('td[data-tier="staging"]')).toContainText("TablePlus · staging");
  await expect(postgres.locator('td[data-tier="staging"]')).toContainText("read-only");
  await expect(postgres.locator('td[data-tier="prod"] .tunnel code')).toHaveText("ssh -N -L 5432:127.0.0.1:5432 root@box.example");
  const hdx = table.locator('tr[data-console="hyperdx"]');
  await expect(hdx.locator('td[data-tier="local"]')).toHaveText("obs runs only on the prod box");
  await expect(hdx.locator('td[data-tier="staging"]')).toContainText("Same as Prod");
  await expect(hdx.locator('td[data-tier="staging"] a')).toHaveAttribute("href", "https://box.example:8443/");
});

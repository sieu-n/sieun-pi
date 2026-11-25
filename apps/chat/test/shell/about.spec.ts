import { expect, test, type Page } from "@playwright/test";

/** Settings > About: one card per box with its Pi, pi-host, apps/chat and Prime versions, from GET /api/about. */

const PI_HOST_SHA = "05d8665a1b2c3d4e5f60718293a4b5c6d7e8f901";
const APPS_CHAT_SHA = "8ceff5102aabbccddeeff00112233445566778899";
const PRIME_SHA = "3e5c3415ab65d4ff8312b54be46c702d80e2c4d3";
const READ_AT = new Date(2026, 10, 26, 4, 7).getTime();

const report = {
  checkedAt: Date.now(),
  piLatest: { version: "1.6.1", checkedAt: Date.now() },
  hosts: [
    {
      box: "us-metal02", state: "up", readAt: Date.now(), error: null,
      versions: {
        pi: "1.4.0",
        piHost: { release: "release-05d8665", sha: PI_HOST_SHA, builtAt: "2026-11-25T20:20:00.000Z" },
        appsChat: { release: "release-8ceff51", sha: APPS_CHAT_SHA, builtAt: null },
        primeVendored: { version: "0.9.8-test.51", sha: PRIME_SHA },
        primeDaemon: "0.9.8-test.51",
      },
    },
    {
      box: "sieun-mac", state: "away", readAt: READ_AT, error: "agent relay away",
      versions: { pi: "1.6.1", piHost: { release: "release-05d8665", sha: PI_HOST_SHA, builtAt: null }, appsChat: null, primeVendored: null, primeDaemon: null },
    },
  ],
};

/** Keeps the live socket shut, so the page reads /api/about over HTTP, where the route below answers it. */
async function withAbout(page: Page, body: unknown): Promise<void> {
  await page.routeWebSocket(/\/api\/live/, () => {});
  await page.route(url => url.pathname === "/api/about", route => route.fulfill({ json: body }));
}

test("About opens from the Settings sidebar and shows each box's versions with commit links", async ({ page }) => {
  await withAbout(page, report);
  await page.goto("/#/settings/usage");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/#\/settings\/about$/);
  await expect(page.getByRole("heading", { name: "About", level: 1 })).toBeVisible();

  const metal = page.getByTestId("about-host-us-metal02");
  await expect(metal).toHaveAttribute("data-state", "up");
  await expect(metal.getByText("Up", { exact: true })).toBeVisible();
  await expect(metal.getByTestId("pi-version")).toHaveText("1.4.0");
  await expect(metal.getByText("1.6.1 out")).toBeVisible();
  await expect(metal.getByText("Newest on npm 1.6.1")).toBeVisible();
  await expect(metal.getByRole("link", { name: "05d8665" })).toHaveAttribute("href", `https://github.com/sieu-n/sieun-pi/commit/${PI_HOST_SHA}`);
  await expect(metal.getByRole("link", { name: "8ceff51" })).toHaveAttribute("href", `https://github.com/sieu-n/sieun-pi/commit/${APPS_CHAT_SHA}`);
  await expect(metal.getByText("release-05d8665, built ")).toBeVisible();
  await expect(metal.getByText("release-8ceff51", { exact: true })).toBeVisible();
  await expect(metal.getByText("0.9.8-test.51", { exact: true })).toHaveCount(2);
  await expect(metal.getByText("3e5c341", { exact: true })).toBeVisible();
  await expect(metal.getByRole("link", { name: "3e5c341" })).toHaveCount(0);
});

test("an away box says when it was last read and keeps its last values, with what it lacks marked", async ({ page }) => {
  await withAbout(page, report);
  await page.goto("/#/settings/about");
  const mac = page.getByTestId("about-host-sieun-mac");
  await expect(mac).toHaveAttribute("data-state", "away");
  await expect(mac.getByText("Away, last read 04:07")).toBeVisible();
  await expect(mac.getByTestId("pi-version")).toHaveText("1.6.1");
  await expect(mac.getByText("1.6.1 out")).toHaveCount(0);
  await expect(mac.getByRole("link", { name: "05d8665" })).toBeVisible();
  await expect(mac.getByText("Not installed")).toBeVisible();
  await expect(mac.getByText("Not found")).toBeVisible();
  await expect(mac.getByText("Not running")).toBeVisible();
});

test("a box never read shows that with the error of its read", async ({ page }) => {
  await withAbout(page, { ...report, hosts: [{ box: "us-metal01", state: "away", readAt: null, error: "no agent relay", versions: null }] });
  await page.goto("/#/settings/about");
  const box = page.getByTestId("about-host-us-metal01");
  await expect(box.getByText("Away, never read")).toBeVisible();
  await expect(box.getByText("Not read")).toBeVisible();
  await expect(box.getByText("no agent relay")).toBeVisible();
});

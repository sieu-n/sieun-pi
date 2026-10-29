import { expect, test } from "@playwright/test";
import { openAgents } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/api\/live/, () => {});
});

test("loading shows card skeletons until the list lands", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/agents", async (route) => {
    await held;
    await route.fulfill({ json: [] });
  });
  await page.goto("/#/agents");
  await expect(page.getByLabel("Loading agents")).toBeVisible({ timeout: 20_000 });
  release();
  await expect(page.getByRole("button", { name: "Create your first agent" })).toBeVisible();
});

test("an error shows the reason and Retry loads the list", async ({ page }) => {
  let fail = true;
  await page.route("**/api/agents", (route) => (fail ? route.fulfill({ status: 500, json: { error: "pi-host is down" } }) : route.fulfill({ json: [] })));
  await page.goto("/#/agents");
  await expect(page.getByText("Agents could not load")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Create your first agent" })).toBeVisible();
});

test("an empty list shows the first-run tile", async ({ page }) => {
  await page.route("**/api/agents", (route) => route.fulfill({ json: [] }));
  await openAgents(page);
  await page.getByRole("button", { name: "Create your first agent" }).click();
  await expect(page.getByRole("dialog", { name: "Create agent" })).toBeVisible();
});

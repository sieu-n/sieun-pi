import { expect, test } from "@playwright/test";
import type { NoModelRoomSetting } from "../../web/src/lib/api/shared/types.ts";
import { openAccounts, postedAction, resetPool } from "./helpers.ts";

/** The pool-wide `no_model_room` control on Settings > Accounts, against the fake pi-pool. It changes server-wide state, so it runs in order. */
test.describe.configure({ mode: "default", timeout: 60_000 });
test.beforeEach(async ({ request }) => { await resetPool(request); });

const PATH = "/api/accounts/no-model-room";
const LABEL = "When no account has room for an agent's model";

test("the control shows the pool's value and default, and a choice sets it through the server with the Settings pane as writer", async ({ page, request }) => {
  await openAccounts(page);
  const setting = page.getByTestId("no-model-room");
  await expect(setting.getByText(LABEL, { exact: true })).toBeVisible();
  await expect(setting.getByText("This applies to sw factory agents. Prime chats keep their own setting.")).toBeVisible();
  const select = setting.getByRole("combobox", { name: LABEL });
  await expect(select).toHaveValue("wait");
  await expect(select.locator("option")).toHaveText(["Wait for an account", "Switch to a model the account has", "Fail the turn"]);
  await expect(setting.getByTestId("no-model-room-by")).toHaveText("pi-pool's default.");

  const fail = await postedAction<{ value: string }, NoModelRoomSetting>(page, PATH, async () => { await select.selectOption({ label: "Fail the turn" }); });
  expect(fail.body).toEqual({ value: "fail" });
  expect(fail.status).toBe(200);
  await expect(setting.getByTestId("no-model-room-by")).toHaveText(/^Set by the Settings pane, /);
  expect(((await (await request.get(PATH)).json()) as NoModelRoomSetting).value).toBe("fail");

  await page.reload();
  await expect(page.getByTestId("no-model-room").getByRole("combobox", { name: LABEL })).toHaveValue("fail");
  await postedAction(page, PATH, async () => { await page.getByTestId("no-model-room").getByRole("combobox", { name: LABEL }).selectOption({ label: "Wait for an account" }); });
  expect(((await (await request.get(PATH)).json()) as NoModelRoomSetting).value).toBe("wait");
});

test("a pool that refuses the write puts the control back and says why", async ({ page }) => {
  await page.route(url => url.pathname === PATH, route =>
    route.request().method() === "POST" ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "pi-pool failed: unknown key no_model_room" }) }) : route.fallback());
  await openAccounts(page);
  const select = page.getByTestId("no-model-room").getByRole("combobox", { name: LABEL });
  await expect(select).toHaveValue("wait");
  await select.selectOption({ label: "Switch to a model the account has" });
  await expect(page.getByText("pi-pool failed: unknown key no_model_room")).toBeVisible();
  await expect(select).toHaveValue("wait");
});

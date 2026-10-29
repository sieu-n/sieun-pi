import { expect, test, type Page } from "@playwright/test";
import { listAgents } from "../agents/helpers";
import { HARNESS_AGENT } from "../board/helpers";

/** Each root draws its own left sidebar, told apart by `data-root` on the sidebar landmark. */
const sidebar = (page: Page) => page.getByTestId("sidebar");
const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Pages" }).getByRole("tab", { name });
const sidebarWidth = async (page: Page) => Math.round((await sidebar(page).boundingBox())?.width ?? 0);
/** A hash change inside the open page, so the router's in-memory tab memory stays. */
const go = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash);

test("each root shows its own sidebar, and the Messages sidebar is gone on Agents and Board", async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await expect(sidebar(page)).toHaveAttribute("data-root", "messages");
  for (const [name, root] of [
    ["Agents", "agents"],
    ["Board", "board"],
    ["Accounts", "accounts"],
  ] as const) {
    await tab(page, name).click();
    await expect(sidebar(page)).toHaveAttribute("data-root", root);
    await expect(page.locator('[data-root="messages"]')).toHaveCount(0);
  }
  await go(page, "#/settings/hosts");
  await expect(sidebar(page)).toHaveAttribute("data-root", "settings");
  await go(page, "#/search?q=deploy");
  await expect(sidebar(page)).toHaveAttribute("data-root", "messages");
  await go(page, "#/ui");
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sidebar/ })).toHaveCount(0);
});

test("old For you links move to Messages in place, with the open ask and the query kept", async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.goto(`/#/board/for-you/${HARNESS_AGENT}/t1?from=link`);
  await expect(page).toHaveURL(new RegExp(`#/c/for-you/${HARNESS_AGENT}/t1\\?from=link$`));
  await expect(page.getByRole("heading", { name: "For you", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ask" })).toBeVisible({ timeout: 20_000 });
  await expect(sidebar(page)).toHaveAttribute("data-root", "messages");
  await page.goBack();
  await expect(page).toHaveURL(/#\/c\/ch_general$/);
});

test("For you at #/c/for-you opens no conversation and keeps the Messages tab", async ({ page }) => {
  await page.goto("/#/c/for-you");
  await expect(page.getByRole("heading", { name: "For you", level: 1 })).toBeVisible();
  await expect(tab(page, "Messages")).toHaveAttribute("aria-selected", "true");
  await expect(sidebar(page)).toHaveAttribute("data-root", "messages");
});

test("each tab returns to the last place in its root, and the open root's tab goes to its home", async ({ page, request }) => {
  const [agent] = await listAgents(request);
  await page.goto("/#/c/ch_general");
  await tab(page, "Agents").click();
  await expect(page).toHaveURL(/#\/agents$/);
  await go(page, `#/agents/${agent!.id}`);
  await tab(page, "Board").click();
  await expect(page).toHaveURL(/#\/board$/);
  await go(page, `#/board/${HARNESS_AGENT}`);
  await tab(page, "Messages").click();
  await expect(page).toHaveURL(/#\/c\/ch_general$/);
  await go(page, "#/c/for-you");
  await tab(page, "Agents").click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent!.id}$`));
  await tab(page, "Agents").click();
  await expect(page).toHaveURL(/#\/agents$/);
  await tab(page, "Board").click();
  await expect(page).toHaveURL(new RegExp(`#/board/${HARNESS_AGENT}$`));
  await tab(page, "Messages").click();
  await expect(page).toHaveURL(/#\/c\/for-you$/);
  await tab(page, "Messages").click();
  await expect(page).toHaveURL(/#\/c\/ch_general$/);
});

test("deep links load with their root's sidebar", async ({ page, request }) => {
  const [agent] = await listAgents(request);
  for (const [hash, root] of [
    [`/#/agents/${agent!.id}`, "agents"],
    [`/#/board/${HARNESS_AGENT}`, "board"],
    ["/#/c/ch_general", "messages"],
  ] as const) {
    await page.goto(hash);
    await expect(sidebar(page)).toHaveAttribute("data-root", root);
  }
});

test("the sidebar toggle and width hold across roots", async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await tab(page, "Board").click();
  await expect(sidebar(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar(page)).toHaveAttribute("data-root", "board");
  await expect.poll(() => sidebarWidth(page)).toBe(260);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => sidebarWidth(page)).toBe(320);
  await tab(page, "Agents").click();
  await expect(sidebar(page)).toHaveAttribute("data-root", "agents");
  await expect.poll(() => sidebarWidth(page)).toBe(320);
});

test("below 650 px every root's sidebar is a drawer", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  for (const [hash, root] of [
    ["/#/agents", "agents"],
    ["/#/board", "board"],
    ["/#/settings/usage", "settings"],
  ] as const) {
    await page.goto(hash);
    await expect(sidebar(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-root", root);
    await expect.poll(() => sidebarWidth(page)).toBe(220);
  }
});

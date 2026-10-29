import { expect, test, type Page } from "@playwright/test";
import { accountState, pendingReset, POOL_PRIORITY_LABEL, resetConfirm, usableGrant } from "../../web/src/pages/accounts/model.ts";
import {
  AGENT, DM, accountChip, accountRow, escape, openConversation, dialog, openAccounts, openMenu, poolState, postedAction, providerOf, providerTab, readView, resetPool, rowIn, showProvider,
  type AccountLogin, type PoolAccount, type UsageRefresh,
} from "./helpers.ts";

/**
 * Every action that changes the fake pi-pool (FEATURES.md 12 to 34 and the picker's choice). They share the fake's state, so this file
 * runs its tests in order in one worker, and each test starts from the seed when the fixture can reset it. The table specs serve a frozen
 * reading, so they never see these changes.
 */
// A box with 80 busy cores slows a cold dev-server page, so each walk gets 60 s.
test.describe.configure({ mode: "default", timeout: 60_000 });
test.beforeEach(async ({ request }) => { await resetPool(request); });

const ACCOUNTS = "/api/accounts";
const LOGIN = "/api/accounts/login";
const REFRESH = "/api/accounts/refresh";
const loginCard = (page: Page, title: string) => page.getByRole("region", { name: title });
/** A ready Claude account that is neither pinned nor the thread's current pick, so a click on it always changes something. */
const spare = (rows: PoolAccount[], not: (string | null | undefined)[] = []) => rows.find(row => accountState(row) === null && !not.includes(row.id));

/** Drops the seed's pool pin through the server, so a thread's Auto is the pool's own pick and not the pin's override. */
async function unpinClaude(request: import("@playwright/test").APIRequestContext): Promise<void> {
  const response = await request.post(ACCOUNTS, { data: { action: "unpin", provider: "anthropic" } });
  expect(response.ok()).toBe(true);
}

/** The account the Claude paste flow adds, so the remove spec can take it back out when the fixture cannot reset. */
let added: PoolAccount | undefined;

test("12 13 Add Claude account walks the paste flow to Signed in, and the new account joins the table", async ({ page, request }) => {
  const before = providerOf(await readView(request), "anthropic").rows;
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const start = await postedAction<{ provider: string; account: string | null }, AccountLogin>(page, LOGIN, () => page.getByRole("button", { name: "Add Claude account" }).click());
  expect(start.body).toEqual({ provider: "anthropic", account: null });
  const card = loginCard(page, "Add a Claude account");
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", /^https?:\/\//, { timeout: 10_000 });
  const field = card.getByRole("textbox", { name: "Callback URL or sign-in code" });
  await expect(card.getByRole("button", { name: "Submit" })).toBeDisabled();
  await field.fill("https://console.anthropic.com/oauth/code/callback?code=fixture-code&state=fixture");
  const paste = await postedAction<{ id: string; code: string }>(page, `${LOGIN}/paste`, () => card.getByRole("button", { name: "Submit" }).click());
  expect(paste.body.id).toBe(start.answer.id);
  expect(paste.body.code).toContain("fixture-code");
  await expect(card.getByText(/Signed in\./)).toBeVisible({ timeout: 15_000 });
  const after = providerOf(await readView(request), "anthropic").rows;
  expect(after.length).toBe(before.length + 1);
  added = after.find(row => !before.some(old => old.id === row.id));
  await expect(providerTab(page, "anthropic")).toContainText(String(after.length));
  await expect(accountRow(page, added!)).toBeVisible();
  await card.getByRole("button", { name: "Done" }).click();
  await expect(card).toHaveCount(0);
});

test("13 Add Codex account shows the device code with Copy, then signs in by itself", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const before = providerOf(await readView(request), "openai-codex").rows.length;
  // The fake's Codex sign-in ends by itself after 3 s, so the page keeps seeing the waiting state until the spec has copied the code.
  let hold = true;
  let waiting: AccountLogin | null = null;
  await page.route(url => url.pathname === LOGIN, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const live = (await response.json()) as AccountLogin | null;
    if (live?.status === "waiting") waiting = live;
    return route.fulfill({ response, json: hold && waiting ? waiting : live });
  });
  await openAccounts(page);
  await showProvider(page, "openai-codex");
  const start = await postedAction<{ provider: string; account: string | null }, AccountLogin>(page, LOGIN, () => page.getByRole("button", { name: "Add Codex account" }).click());
  expect(start.body).toEqual({ provider: "openai-codex", account: null });
  const card = loginCard(page, "Add a Codex account");
  await expect(card.getByRole("link", { name: "Open sign-in page" })).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("ABCD-1234");
  await expect(card.getByRole("textbox", { name: "Callback URL or sign-in code" })).toHaveCount(0);
  await card.getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-1234");
  hold = false;
  await expect(card.getByText(/Signed in\./)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => providerOf(await readView(request), "openai-codex").rows.length).toBe(before + 1);
  await expect(providerTab(page, "openai-codex")).toContainText(String(before + 1));
});

test("13 Cancel ends a sign-in with no new account", async ({ page, request }) => {
  const before = providerOf(await readView(request), "anthropic").rows.length;
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const start = await postedAction<{ provider: string; account: string | null }, AccountLogin>(page, LOGIN, () => page.getByRole("button", { name: "Add Claude account" }).click());
  const card = loginCard(page, "Add a Claude account");
  await expect(card.getByRole("textbox", { name: "Callback URL or sign-in code" })).toBeVisible({ timeout: 10_000 });
  const cancel = await postedAction<{ id: string }>(page, `${LOGIN}/cancel`, () => card.getByRole("button", { name: "Cancel" }).click());
  expect(cancel.body.id).toBe(start.answer.id);
  await expect(card.getByText("Sign-in cancelled.")).toBeVisible();
  expect(((await (await request.get(LOGIN)).json()) as AccountLogin).status).toBe("cancelled");
  expect(providerOf(await readView(request), "anthropic").rows.length).toBe(before);
  await expect(page.getByRole("button", { name: "Add Claude account" })).toBeEnabled();
});

test("13 a failed sign-in says why and Try again starts a new one", async ({ page }) => {
  const failed: AccountLogin = { id: "login-failed", provider: "anthropic", account: null, status: "failed", url: null, manualUrl: null, code: null, paste: true, message: "The callback state did not match." };
  let fail = true;
  await page.route(url => url.pathname === LOGIN, route => (fail ? route.fulfill({ contentType: "application/json", body: JSON.stringify(failed) }) : route.fallback()));
  await openAccounts(page);
  await showProvider(page, "anthropic");
  await page.getByRole("button", { name: "Add Claude account" }).click();
  const card = loginCard(page, "Add a Claude account");
  await expect(card.getByText(/The sign-in failed\./)).toBeVisible();
  await expect(card).toContainText("The callback state did not match.");
  fail = false;
  const again = await postedAction<{ provider: string; account: string | null }, AccountLogin>(page, LOGIN, () => card.getByRole("button", { name: "Try again" }).click());
  expect(again.body).toEqual({ provider: "anthropic", account: null });
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("Sign-in cancelled.")).toBeVisible();
});

test("14 15 19 Refresh all counts its progress on the button, marks each row, then sums up with the ones not read and Dismiss", async ({ page, request }) => {
  const rows = providerOf(await readView(request), "anthropic").rows.slice(0, 3);
  test.skip(rows.length < 3, "the fake seeds fewer than three Claude accounts");
  const entry = (row: PoolAccount, state: UsageRefresh["accounts"][number]["state"], reason: string | null = null) =>
    ({ id: row.id, email: row.email, label: row.label, state, reason, usageAt: null, retryAt: null });
  const base = { id: "refresh-spec", provider: "anthropic" as const, account: null, message: null, startedAt: Date.now(), endedAt: null };
  const running: UsageRefresh = { ...base, status: "running", accounts: [entry(rows[0]!, "read"), entry(rows[1]!, "reading"), entry(rows[2]!, "queued")] };
  const done: UsageRefresh = { ...base, status: "done", endedAt: Date.now(), accounts: [entry(rows[0]!, "read"), entry(rows[1]!, "read"), entry(rows[2]!, "failed", "usage endpoint answered 500")] };
  let current: UsageRefresh | null = null;
  await page.route(url => url.pathname === REFRESH, route => {
    if (route.request().method() === "POST") current = running;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().method() === "POST" ? current : current ? [current] : []) });
  });
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const asked = page.waitForRequest(req => new URL(req.url()).pathname === REFRESH && req.method() === "POST");
  await page.getByRole("button", { name: "Refresh all" }).click();
  expect(JSON.parse((await asked).postData()!)).toEqual({ provider: "anthropic", account: null });
  await expect(page.getByRole("button", { name: /Reading 1 of 3/ })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Reading usage: 1 of 3 done." })).toBeVisible();
  await expect(accountRow(page, rows[1]!).getByText("Reading")).toBeVisible();
  await expect(accountRow(page, rows[2]!).getByText("Queued", { exact: true })).toBeVisible();
  current = done;
  const summary = page.getByRole("status").filter({ hasText: "Read 2 of 3 accounts just now." });
  await expect(summary).toBeVisible({ timeout: 5_000 });
  await expect(summary).toContainText(`Not read: ${rows[2]!.label}.`);
  await expect(accountRow(page, rows[0]!).getByText("Updated", { exact: true })).toBeVisible();
  await expect(accountRow(page, rows[2]!).getByText("Not read", { exact: true })).toBeVisible();
  await expect(accountRow(page, rows[2]!)).toContainText("Not read: usage endpoint answered 500.");
  await expect(page.getByRole("button", { name: "Refresh all" })).toBeEnabled();
  await summary.getByRole("button", { name: "Dismiss" }).click();
  await expect(summary).toHaveCount(0);
});

test("14 Refresh all reads every Claude account through the fake pool", async ({ page, request }) => {
  const total = providerOf(await readView(request), "anthropic").rows.length;
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const start = await postedAction<{ provider: string; account: string | null }, UsageRefresh>(page, REFRESH, () => page.getByRole("button", { name: "Refresh all" }).click());
  expect(start.body).toEqual({ provider: "anthropic", account: null });
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`Read \\d+ of ${total} accounts just now\\.`) })).toBeVisible({ timeout: 20_000 });
  const runs = (await (await request.get(REFRESH)).json()) as UsageRefresh[];
  expect(runs.find(run => run.id === start.answer.id)?.status).toBe("done");
});

test("19 the row's refresh reads that one account and marks the row", async ({ page, request }) => {
  const row = spare(providerOf(await readView(request), "anthropic").rows)!;
  await openAccounts(page);
  const line = accountRow(page, row);
  await line.hover();
  const start = await postedAction(page, REFRESH, () => page.getByRole("button", { name: `Refresh usage for ${row.label}` }).click());
  expect(start.body).toEqual({ provider: "anthropic", account: row.id });
  await expect(line.getByText(/^(Updated|Not read)$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`(Read|Could not read) ${row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeVisible();
});

test("16 17 Check resets reads every Claude account's resets and shows the pool's notice with Dismiss", async ({ page }) => {
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const check = await postedAction(page, ACCOUNTS, () => page.getByRole("button", { name: "Check resets" }).click());
  expect(check.body).toEqual({ action: "resets", provider: "anthropic" });
  expect(check.status).toBe(200);
  expect(check.answer.notice, "the fake's resets command says what it read").toBeTruthy();
  const notice = page.getByText(check.answer.notice!.split("\n")[0]!.slice(0, 60));
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).first().click();
  await expect(notice).toHaveCount(0);
  await showProvider(page, "openai-codex");
  await expect(page.getByRole("button", { name: "Check resets" })).toHaveCount(0);
});

test("20 21 pin asks first and pins for all sessions, and unpin asks and clears it", async ({ page, request }) => {
  const claude = providerOf(await readView(request), "anthropic");
  const row = spare(claude.rows, [claude.poolPin])!;
  await openAccounts(page);
  let menu = await openMenu(page, row);
  await menu.getByRole("menuitem", { name: "Pin for all sessions" }).click();
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: `Pin ${row.label} for all sessions?` })).toBeVisible();
  await expect(ask).toContainText("stays on this account until you unpin it");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  expect(providerOf(await readView(request), "anthropic").poolPin ?? null).toBe(claude.poolPin ?? null);

  menu = await openMenu(page, row);
  await menu.getByRole("menuitem", { name: "Pin for all sessions" }).click();
  const pin = await postedAction(page, ACCOUNTS, () => dialog(page).getByRole("button", { name: "Pin", exact: true }).click());
  expect(pin.body).toEqual({ action: "pin", provider: "anthropic", account: row.id });
  const pinned = providerOf(await readView(request), "anthropic");
  expect(pinned.poolPin).toBe(row.id);
  expect(pinned.rows.find(entry => entry.id === row.id)?.pinned).toBe(true);
  await expect(accountRow(page, row).getByText("Pinned", { exact: true })).toBeVisible();

  menu = await openMenu(page, row);
  await menu.getByRole("menuitem", { name: "Unpin for all sessions" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Unpin Claude?" })).toBeVisible();
  await expect(dialog(page)).toContainText("Sessions go back to the pool's own choice.");
  const unpin = await postedAction(page, ACCOUNTS, () => dialog(page).getByRole("button", { name: "Unpin", exact: true }).click());
  expect(unpin.body).toEqual({ action: "unpin", provider: "anthropic" });
  const after = providerOf(await readView(request), "anthropic");
  expect(after.poolPin ?? null).toBeNull();
  expect(after.rows.some(entry => entry.pinned)).toBe(false);
  await expect(accountRow(page, row).getByText("Pinned", { exact: true })).toHaveCount(0);
});

test("22 Use reset says how many are left, what it clears and the usage, spends one and reads the account", async ({ page, request }) => {
  const row = providerOf(await readView(request), "anthropic").rows.find(entry => !entry.disabled && !pendingReset(entry.resets) && usableGrant(entry.resets));
  expect(row, "the fake seeds a Claude account with a usable reset").toBeTruthy();
  const confirm = resetConfirm(row!)!;
  const left = usableGrant(row!.resets)!.resetsLeft;
  await openAccounts(page);
  await accountRow(page, row!).getByRole("button", { name: "Use reset", exact: true }).click();
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: confirm.title })).toBeVisible();
  await expect(ask).toContainText(`This spends 1 of ${left} banked reset`);
  await expect(ask).toContainText("A spent reset cannot be given back.");
  const refreshed = page.waitForRequest(req => new URL(req.url()).pathname === REFRESH && req.method() === "POST", { timeout: 15_000 });
  const spend = await postedAction(page, ACCOUNTS, () => ask.getByRole("button", { name: confirm.label, exact: true }).click());
  expect(spend.body).toEqual({ action: "reset", provider: "anthropic", account: row!.id, grant: confirm.grant });
  expect(JSON.parse((await refreshed).postData()!)).toEqual({ provider: "anthropic", account: row!.id });
  const after = providerOf(await readView(request), "anthropic").rows.find(entry => entry.id === row!.id)!;
  expect(after.resets?.grants.find(grant => grant.id === confirm.grant)?.resetsLeft).toBe(left - 1);
});

test("23 Retry reset resends the pending claim with its own grant", async ({ page, request }) => {
  const row = providerOf(await readView(request), "anthropic").rows.find(entry => !entry.disabled && pendingReset(entry.resets));
  expect(row, "the fake seeds a Claude account with a pending reset claim under 10 min old").toBeTruthy();
  const pending = pendingReset(row!.resets)!;
  await openAccounts(page);
  await accountRow(page, row!).getByRole("button", { name: "Retry reset", exact: true }).click();
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: `Retry the reset on ${row!.label}?` })).toBeVisible();
  await expect(ask).toContainText("A retry sends the same request id");
  const retry = await postedAction(page, ACCOUNTS, () => ask.getByRole("button", { name: "Retry the same claim" }).click());
  expect(retry.body).toEqual({ action: "reset", provider: "anthropic", account: row!.id, grant: pending.grantId });
  const after = providerOf(await readView(request), "anthropic").rows.find(entry => entry.id === row!.id)!;
  expect(after.resets?.pending ?? null).toBeNull();
  await expect(accountRow(page, row!).getByText("Reset unknown", { exact: true })).toHaveCount(0);
});

test("24 Check resets in a row's menu reads that one account", async ({ page, request }) => {
  const row = spare(providerOf(await readView(request), "anthropic").rows)!;
  const before = row.resets?.checkedAt ?? 0;
  await openAccounts(page);
  const menu = await openMenu(page, row);
  const check = await postedAction(page, ACCOUNTS, () => menu.getByRole("menuitem", { name: "Check resets" }).click());
  expect(check.body).toEqual({ action: "resets", provider: "anthropic", account: row.id });
  expect(check.status).toBe(200);
  const after = providerOf(await readView(request), "anthropic").rows.find(entry => entry.id === row.id)!;
  expect(after.resets?.checkedAt ?? 0).toBeGreaterThan(before);
});

test("25 Check again shows for refused, cooling and needs-terms accounts and asks before it probes", async ({ page, request }) => {
  const view = await readView(request);
  const refused = rowIn(view, "anthropic", "refused") ?? rowIn(view, "anthropic", "cooldown") ?? rowIn(view, "anthropic", "needs-terms");
  expect(refused, "the fake seeds a refused, cooling or needs-terms Claude account").toBeTruthy();
  await openAccounts(page);
  for (const state of ["refused", "cooldown", "needs-terms"] as const) {
    const row = rowIn(view, "anthropic", state);
    if (!row) continue;
    const menu = await openMenu(page, row);
    await expect(menu.getByRole("menuitem", { name: "Check again" }), state).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const ready = spare(providerOf(view, "anthropic").rows)!;
  await expect((await openMenu(page, ready)).getByRole("menuitem", { name: "Check again" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const menu = await openMenu(page, refused!);
  await menu.getByRole("menuitem", { name: "Check again" }).click();
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: "Check refused accounts again?" })).toBeVisible();
  await expect(ask).toContainText("one free request per Claude account");
  const probe = await postedAction(page, ACCOUNTS, () => ask.getByRole("button", { name: "Check again" }).click());
  expect(probe.body).toEqual({ action: "recheck", provider: "anthropic" });
  expect(probe.status).toBe(200);
  await expect(ask).toHaveCount(0);
});

test("26 Sign in again starts a login for that account, from the row and from the menu", async ({ page, request }) => {
  const row = rowIn(await readView(request), "anthropic", "needs-login");
  expect(row, "the fake seeds a Claude account whose sign-in expired").toBeTruthy();
  await openAccounts(page);
  const line = accountRow(page, row!);
  await expect(line).toContainText("The sign-in expired.");
  const start = await postedAction(page, LOGIN, () => line.getByRole("button", { name: "Sign in again" }).click());
  expect(start.body).toEqual({ provider: "anthropic", account: row!.id });
  const card = loginCard(page, `Sign in again as ${row!.label}`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("Sign-in cancelled.")).toBeVisible();
  await card.getByRole("button", { name: "Close" }).click();

  const menu = await openMenu(page, row!);
  const again = await postedAction(page, LOGIN, () => menu.getByRole("menuitem", { name: "Sign in again" }).click());
  expect(again.body).toEqual({ provider: "anthropic", account: row!.id });
  await loginCard(page, `Sign in again as ${row!.label}`).getByRole("button", { name: "Cancel" }).click();
});

test("27 Turn off takes an account out of Auto, and Turn on brings it back", async ({ page, request }) => {
  const row = spare(providerOf(await readView(request), "anthropic").rows)!;
  await openAccounts(page);
  const menu = await openMenu(page, row);
  const off = await postedAction(page, ACCOUNTS, () => menu.getByRole("menuitem", { name: "Turn off" }).click());
  expect(off.body).toEqual({ action: "disable", provider: "anthropic", account: row.id });
  expect(providerOf(await readView(request), "anthropic").rows.find(entry => entry.id === row.id)?.disabled).toBe(true);
  const line = accountRow(page, row);
  await expect(line.getByText("Off", { exact: true })).toBeVisible();
  await expect(line).toContainText("Off excludes this account from Auto. Manual can still use it.");
  const on = await postedAction(page, ACCOUNTS, () => line.getByRole("button", { name: "Turn on" }).click());
  expect(on.body).toEqual({ action: "enable", provider: "anthropic", account: row.id });
  expect(providerOf(await readView(request), "anthropic").rows.find(entry => entry.id === row.id)?.disabled).toBe(false);
  await expect(line.getByText("Off", { exact: true })).toHaveCount(0);
});

test("28 remove needs the typed label", async ({ page, request }) => {
  const rows = providerOf(await readView(request), "anthropic").rows;
  const row = rows.find(entry => entry.id === added?.id) ?? rows.find(entry => entry.disabled) ?? rows[rows.length - 1]!;
  await openAccounts(page);
  const menu = await openMenu(page, row);
  await menu.getByRole("menuitem", { name: "Remove" }).click();
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: `Remove ${row.label}?` })).toBeVisible();
  await expect(ask).toContainText("This deletes its sign-in and drops its pins.");
  const remove = ask.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toBeDisabled();
  const field = ask.getByRole("textbox");
  await field.fill(row.label.slice(0, -1));
  await expect(remove).toBeDisabled();
  await field.press("Enter");
  await expect(ask).toBeVisible();
  await field.fill(row.label);
  await expect(remove).toBeEnabled();
  const gone = await postedAction(page, ACCOUNTS, () => remove.click());
  expect(gone.body).toEqual({ action: "remove", provider: "anthropic", account: row.id });
  const after = providerOf(await readView(request), "anthropic").rows;
  expect(after.some(entry => entry.id === row.id)).toBe(false);
  const fake = (await poolState(request)) as { accounts: { id: string }[] } | null;
  expect(fake, "the fixture serves the fake pi-pool's state").toBeTruthy();
  expect(fake!.accounts.some(entry => entry.id === row.id), "the fake dropped the account's sign-in").toBe(false);
  await expect(accountRow(page, row)).toHaveCount(0);
  await expect(providerTab(page, "anthropic")).toContainText(String(after.length));
});

test("29 the More menu holds every row action, and Use in this thread only with a thread", async ({ page, request }) => {
  const view = await readView(request);
  const row = spare(providerOf(view, "anthropic").rows, [providerOf(view, "anthropic").resolution?.account])!;
  await openAccounts(page);
  let menu = await openMenu(page, row);
  const reset = pendingReset(row.resets) ? ["Retry the reset"] : usableGrant(row.resets) ? ["Use a reset"] : [];
  await expect(menu.getByRole("menuitem")).toHaveText(["Refresh usage", "Pin for all sessions", ...reset, "Check resets", "Sign in again", "Turn off", "Remove"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  const codex = providerOf(view, "openai-codex").rows.find(entry => !entry.disabled);
  if (codex) {
    await showProvider(page, "openai-codex");
    menu = await openMenu(page, codex);
    await expect(menu.getByRole("menuitem", { name: "Check resets" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  await openAccounts(page, DM);
  // The tab stays on the provider picked before, so the spec goes back to Claude.
  await showProvider(page, "anthropic");
  menu = await openMenu(page, row);
  await expect(menu.getByRole("menuitem").first()).toHaveText("Use in this thread");
});

test("31 32 Use in this thread keeps the account for the thread, and Auto gives it back to the pool", async ({ page, request }) => {
  await unpinClaude(request);
  const claude = providerOf(await readView(request, DM), "anthropic");
  const row = spare(claude.rows, [claude.resolution?.account, claude.poolPin])!;
  await openAccounts(page, DM);
  const use = await postedAction(page, ACCOUNTS, () => accountRow(page, row).getByRole("button", { name: `Use ${row.label} in this thread` }).click());
  expect(use.body).toEqual({ action: "use", provider: "anthropic", account: row.id, id: DM });
  const manual = providerOf(await readView(request, DM), "anthropic").resolution?.selection;
  expect(manual).toEqual({ mode: "manual", account_id: row.id });
  await expect(page.getByText(`Manual keeps ${row.label} selected for this thread.`)).toBeVisible();
  await expect(accountRow(page, row).getByText("Manual", { exact: true })).toBeVisible();
  await expect(accountRow(page, row).getByRole("button", { name: `Use ${row.label} in this thread` })).toHaveCount(0);
  // The agent id names the same work thread as its DM room.
  expect(providerOf(await readView(request, AGENT), "anthropic").resolution?.selection).toEqual(manual);

  const auto = page.getByRole("button", { name: /^Auto/ });
  await expect(auto).toHaveAttribute("aria-pressed", "false");
  const follow = await postedAction(page, ACCOUNTS, () => auto.click());
  expect(follow.body).toEqual({ action: "follow", provider: "anthropic", id: DM });
  expect(providerOf(await readView(request, DM), "anthropic").resolution?.selection).toEqual({ mode: "auto" });
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await expect(auto).toBeDisabled();
  await expect(page.getByText(/^Auto uses /)).toBeVisible();
});

test("31 Use in this thread from the row's menu", async ({ page, request }) => {
  await unpinClaude(request);
  const claude = providerOf(await readView(request, DM), "anthropic");
  const row = spare(claude.rows, [claude.resolution?.account, claude.poolPin])!;
  await openAccounts(page, DM);
  const menu = await openMenu(page, row);
  const use = await postedAction(page, ACCOUNTS, () => menu.getByRole("menuitem", { name: "Use in this thread" }).click());
  expect(use.body).toEqual({ action: "use", provider: "anthropic", account: row.id, id: DM });
  await expect(page.getByText(`Manual keeps ${row.label} selected for this thread.`)).toBeVisible();
  await postedAction(page, ACCOUNTS, () => page.getByRole("button", { name: /^Auto/ }).click());
});

test("33 a thread moved to another account runs again now", async () => {
  test.skip(true, "The fixture host has no failed or retry-waiting turn to rerun, so retryNow is not reachable from a browser here.");
});

test("34 the thread's pool class shows with its hint, and the picker moves it", async ({ page, request }) => {
  const view = await readView(request, DM);
  expect(view.priority, "the fake answers a pool class for the fixture's thread").toBeTruthy();
  await openAccounts(page, DM);
  const button = page.getByRole("button", { name: new RegExp(`^${POOL_PRIORITY_LABEL[view.priority!]}`) });
  await button.hover();
  await expect(page.getByRole("tooltip")).toContainText("The pool admits high threads first");
  const target = view.priority === "high" ? "low" : "high";
  await button.click();
  const choice = page.getByRole("menuitemradio", { name: new RegExp(`^${POOL_PRIORITY_LABEL[target]}`) })
    .or(page.getByRole("option", { name: new RegExp(`^${POOL_PRIORITY_LABEL[target]}`) }));
  const move = await postedAction(page, "/api/accounts/priority", () => choice.click());
  expect(move.body).toEqual({ thread: DM, priority: target });
  expect((await readView(request, DM)).priority).toBe(target);
  const fake = (await poolState(request)) as { trees: Record<string, { priority?: string }> } | null;
  expect(fake?.trees[view.sessionId!]?.priority, "the fake tree's class").toBe(target);
  await expect(page.getByRole("button", { name: new RegExp(`^${POOL_PRIORITY_LABEL[target]}`) })).toBeVisible();
  await request.post("/api/accounts/priority", { data: { thread: DM, priority: view.priority } });
});

test("36 choosing an account in the chip's picker keeps it for the thread, and Auto gives it back", async ({ page, request }) => {
  await unpinClaude(request);
  const claude = providerOf(await readView(request, DM), "anthropic");
  const row = spare(claude.rows, [claude.resolution?.account, claude.poolPin])!;
  await openConversation(page, DM);
  const chip = accountChip(page);
  await chip.click();
  const choice = (name: RegExp) => page.getByRole("option", { name }).or(page.getByRole("menuitemradio", { name }));
  const use = await postedAction(page, ACCOUNTS, () => choice(new RegExp(escape(row.email))).click());
  expect(use.body).toMatchObject({ action: "use", provider: "anthropic", account: row.id });
  expect([DM, AGENT]).toContain((use.body as { id: string }).id);
  expect(providerOf(await readView(request, DM), "anthropic").resolution?.selection).toEqual({ mode: "manual", account_id: row.id });
  await expect(chip).toContainText("Manual");
  await expect(chip).toContainText(row.email);

  await chip.click();
  const follow = await postedAction(page, ACCOUNTS, () => choice(/^Auto/).click());
  expect(follow.body).toMatchObject({ action: "follow", provider: "anthropic" });
  expect(providerOf(await readView(request, DM), "anthropic").resolution?.selection).toEqual({ mode: "auto" });
  await expect(chip).toContainText("Auto");
});

test("38 a new agent can start on a chosen account", async () => {
  test.skip(true, "Out of scope for sw factory: pi-pool refuses a pick on a tree with no pool record, so a new agent cannot start on a chosen account.");
});

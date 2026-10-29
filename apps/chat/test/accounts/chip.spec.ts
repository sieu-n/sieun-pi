import { expect, test } from "@playwright/test";
import { accountState, reasonText, resetText, resolvedAccount, shownWindows, staleText, STATE_LABEL, windowLabel } from "../../web/src/pages/accounts/model.ts";
import { DM, accountChip, escape, firstJob, hintOf, makeRow, openConversation, providerOf, readView, serveView, withProvider, type PoolAccount } from "./helpers.ts";

// A box with 80 busy cores slows a cold dev-server page, so each walk gets 60 s.
test.describe.configure({ timeout: 60_000 });

/**
 * The account chip in a DM's and a job's header and its picker (FEATURES.md 35 to 37 and 39), against one served reading. The fixture's
 * threads run claude-opus-5-5 (server/fixture/seed.ts), so their provider is Claude.
 */
const MODEL = "claude-opus-5-5";

test("35 the chip in a DM's header shows Auto, the account, its meters and a hint with the reason and each reset", async ({ page }) => {
  const view = await readView(page.request, DM);
  await serveView(page, view);
  const claude = providerOf(view, "anthropic");
  const account = resolvedAccount(claude);
  test.skip(!account, "the fake resolves no Claude account for Vent's thread");
  await openConversation(page, DM);
  const chip = accountChip(page);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(claude.resolution?.selection.mode === "manual" ? "Manual" : "Auto");
  await expect(chip).toContainText(account!.email);
  const windows = shownWindows(account!.windows, MODEL);
  await expect(chip.getByRole("meter")).toHaveCount(windows.length);
  for (const window of windows) await expect(chip.getByRole("meter", { name: windowLabel(window), exact: true })).toHaveAttribute("aria-valuenow", String(window.pct));
  const hint = await hintOf(page, chip);
  const why = reasonText(claude.resolution?.reason);
  if (why && claude.resolution?.selection.mode !== "manual") expect(hint).toContain(why);
  for (const window of windows) {
    expect(hint).toContain(`${windowLabel(window)} ${Math.round(window.pct)}%`);
    if (resetText(window)) expect(hint).toContain("resets in ");
  }
});

test("35 the chip shows Manual for a kept account and warns when the thread has no account or an error", async ({ page }) => {
  const view = await readView(page.request, DM);
  const row = providerOf(view, "anthropic").rows[0]!;
  let served = withProvider(view, "anthropic", { resolution: { account: row.id, email: row.email, reason: "session_pin", pinned: true, selection: { mode: "manual", account_id: row.id }, error: null }, wait: null, poolPin: null });
  await serveView(page, () => served);
  await openConversation(page, DM);
  const chip = accountChip(page);
  await expect(chip).toContainText("Manual");
  await expect(chip).toContainText(row.email);
  expect(await hintOf(page, chip)).toContain(`Manual keeps ${row.label} selected for this thread.`);

  served = withProvider(view, "anthropic", { resolution: { account: null, email: null, reason: null, pinned: false, selection: { mode: "auto" }, error: "Every Claude account is at its 5h limit." }, wait: null, poolPin: null });
  await page.reload();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveClass(/warning/);
  expect(await hintOf(page, chip)).toContain("Every Claude account is at its 5h limit.");
});

test("35 a job's header has the chip too", async ({ page }) => {
  const job = await firstJob(page.request);
  test.skip(!job, "the fixture has no live job");
  const view = await readView(page.request, job!);
  await serveView(page, view);
  await openConversation(page, job!);
  const chip = accountChip(page);
  await expect(chip).toBeVisible();
  const account = resolvedAccount(providerOf(view, "anthropic"));
  if (account) await expect(chip).toContainText(account.email);
});

test("36 37 the chip opens the picker with Auto and its next pick, then every account with plan, meters, stale note and state", async ({ page }) => {
  const view = await readView(page.request, DM);
  await serveView(page, view);
  const claude = providerOf(view, "anthropic");
  await openConversation(page, DM);
  await accountChip(page).click();
  const picker = page.getByRole("dialog").or(page.getByRole("menu")).or(page.getByRole("listbox")).first();
  await expect(picker).toBeVisible();
  const choice = (name: string | RegExp) => picker.getByRole("option", { name }).or(picker.getByRole("menuitemradio", { name }));
  const next = claude.rows.find(row => row.id === claude.resolution?.account);
  const auto = choice(/^Auto/);
  await expect(auto).toBeVisible();
  // A manual thread has no next pick of its own, so Auto says the pool picks again; an Auto thread names the pool's next pick.
  if (claude.resolution?.selection.mode === "manual") await expect(auto).toContainText("The pool picks again on the next request");
  else if (next) await expect(auto).toContainText(`Next pick: ${next.label}`);
  for (const row of claude.rows) {
    const item = choice(new RegExp(`^${escape(row.label)}`));
    await expect(item).toHaveCount(1);
    if (row.plan) await expect(item).toContainText(row.plan);
    const stale = staleText(row);
    if (stale) await expect(item).toContainText(stale.split(/\d/)[0]!);
    const state = accountState(row);
    if (state) await expect(item).toContainText(STATE_LABEL[state].label);
    for (const window of shownWindows(row.windows, MODEL)) await expect(item.getByRole("meter", { name: windowLabel(window), exact: true })).toBeVisible();
  }
  // The picker takes focus a tick after it opens, and Esc closes it from there.
  await expect(picker.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
});

test("37 an Auto thread's picker names the pool's next pick on Auto and on its row", async ({ page }) => {
  const view = await readView(page.request, DM);
  const claude = providerOf(view, "anthropic");
  const next = claude.rows.find(row => accountState(row) === null)!;
  await serveView(page, withProvider(view, "anthropic", {
    resolution: { account: next.id, email: next.email, reason: "new", pinned: false, selection: { mode: "auto" }, error: null }, wait: null, poolPin: null,
  }));
  await openConversation(page, DM);
  await expect(accountChip(page)).toContainText("Auto");
  await accountChip(page).click();
  await expect(page.getByRole("option", { name: /^Auto/ })).toContainText(`Next pick: ${next.label}`);
  const row = page.getByRole("option", { name: new RegExp(`^${escape(next.label)}`) });
  await expect(row).toContainText("Next pick");
  await expect(row).toContainText("Next");
});

test("39 the chip's meters show a per-model window only for the model the thread runs", async ({ page }) => {
  const view = await readView(page.request, DM);
  const now = Date.now();
  const windows: PoolAccount["windows"] = [
    { kind: "session", label: "5h", pct: 30, resetsAt: now + 3600_000 },
    { kind: "weekly", label: "week", pct: 50, resetsAt: now + 3 * 86_400_000 },
    { kind: "model", label: "Fable", pct: 75, resetsAt: now + 3 * 86_400_000 },
    { kind: "model", label: "Opus", pct: 91, resetsAt: now + 3 * 86_400_000 },
  ];
  const row = makeRow("meters", { windows });
  await serveView(page, withProvider(view, "anthropic", {
    rows: [row], resolution: { account: row.id, email: row.email, reason: null, pinned: false, selection: { mode: "auto" }, error: null }, wait: null, poolPin: null,
  }));
  await openConversation(page, DM);
  const chip = accountChip(page);
  await expect(chip.getByRole("meter", { name: "5h", exact: true })).toBeVisible();
  await expect(chip.getByRole("meter", { name: "Week", exact: true })).toBeVisible();
  await expect(chip.getByRole("meter", { name: "Opus", exact: true })).toBeVisible();
  await expect(chip.getByRole("meter", { name: "Fable", exact: true })).toHaveCount(0);
});

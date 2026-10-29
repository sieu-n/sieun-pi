import { expect, test } from "@playwright/test";
import {
  accountState, isManualAccount, meterTone, pendingReset, planText, rowNotes, sortedRows, STATE_LABEL, threadsText, usableGrant, windowColumns, windowLabel,
} from "../../web/src/pages/accounts/model.ts";
// The old chat's pool meter rule, so the tab is checked against the math the owner already used.
import { poolCaps, poolSummary } from "../../../../legacy/prime/user-history/src/client/pool-meter.ts";
import {
  accountRow, makeRow, openAccounts, PROVIDER_LABEL, providerOf, providerTab, readView, rowIn, serveView, showProvider, tableRows, withProvider,
  type AccountsView, type ProviderId,
} from "./helpers.ts";

// A box with 80 busy cores slows a cold dev-server page, so each walk gets 60 s.
test.describe.configure({ timeout: 60_000 });

/**
 * The table and its read-only parts (FEATURES.md 1 to 11 and 18). Each spec reads the fake pi-pool once through GET /api/accounts and
 * serves that reading to the page, so the actions spec acting on the same fake never moves the rows under it.
 */
const PROVIDERS: ProviderId[] = ["anthropic", "openai-codex"];
const TONE_CLASS = { low: /\bok\b/, mid: /\bwarn\b/, high: /\bdanger\b/ } as const;

async function frozen(page: import("@playwright/test").Page): Promise<AccountsView> {
  const view = await readView(page.request);
  await serveView(page, view);
  return view;
}

test("1 the Claude and Codex tabs each show their account count", async ({ page }) => {
  const view = await frozen(page);
  await openAccounts(page);
  for (const provider of PROVIDERS) {
    const rows = providerOf(view, provider).rows;
    await expect(providerTab(page, provider)).toContainText(String(rows.length));
    await showProvider(page, provider);
    await expect(tableRows(page)).toHaveCount(rows.length);
  }
});

test("2 each account has one row with its label and plan", async ({ page }) => {
  const view = await frozen(page);
  await openAccounts(page);
  for (const provider of PROVIDERS) {
    await showProvider(page, provider);
    for (const row of providerOf(view, provider).rows) {
      const line = accountRow(page, row);
      await expect(line).toHaveCount(1);
      const plan = planText(row);
      if (plan) await expect(line).toContainText(plan);
    }
  }
});

test("3 each usage window has a column with its percent, a toned bar and when it resets", async ({ page }) => {
  // Every row and window of both providers, so this walk takes longer than one action.
  test.slow();
  const view = await frozen(page);
  await openAccounts(page);
  let toned = 0;
  for (const provider of PROVIDERS) {
    await showProvider(page, provider);
    const rows = providerOf(view, provider).rows;
    for (const column of windowColumns(rows)) await expect(page.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
    for (const row of rows) {
      const line = accountRow(page, row);
      for (const window of row.windows) {
        await expect(line).toContainText(`${Math.round(window.pct)}%`);
        // The meter's caption is its reset time, and its title names the window, as in "5h: 42% used, resets in 3h 4m".
        const meter = line.locator(`[role="meter"][title^="${windowLabel(window)}:"]`);
        await expect(meter).toHaveAttribute("aria-valuenow", String(window.pct));
        await expect(meter).toHaveClass(TONE_CLASS[meterTone(window.pct)]);
        if (meterTone(window.pct) !== "low") toned++;
        if (window.resetsAt && window.resetsAt > Date.now()) await expect(line).toContainText("resets in ");
      }
    }
  }
  expect(toned, "the fake seeds no window at 70% or more, so the warning and danger bars go unseen").toBeGreaterThan(0);
});

test("4 each row shows its one state badge, and the fake covers every state", async ({ page }) => {
  // Every row and window of both providers, so this walk takes longer than one action.
  test.slow();
  const view = await frozen(page);
  await openAccounts(page);
  const seen = new Set<string>();
  for (const provider of PROVIDERS) {
    await showProvider(page, provider);
    for (const row of providerOf(view, provider).rows) {
      const state = accountState(row);
      const line = accountRow(page, row);
      for (const [key, badge] of Object.entries(STATE_LABEL)) {
        const shown = line.getByText(badge.label, { exact: true });
        if (key === state) await expect(shown).toBeVisible();
        else await expect(shown).toHaveCount(0);
      }
      if (state) seen.add(state);
    }
  }
  expect([...seen].sort(), "states the fake pi-pool seeds").toEqual(Object.keys(STATE_LABEL).sort());
});

test("5 a row used by threads shows the count with a hint that names the window", async ({ page }) => {
  const view = await frozen(page);
  const row = rowIn(view, "anthropic", null, entry => entry.sessions > 0) ?? providerOf(view, "anthropic").rows.find(entry => entry.sessions > 0);
  test.skip(!row, "the fake seeds no Claude account with threads");
  const text = threadsText(row!, view.poolConfig)!;
  await openAccounts(page);
  const count = accountRow(page, row!).getByText(text.label, { exact: true });
  await expect(count).toBeVisible();
  await count.hover();
  await expect(page.getByRole("tooltip")).toContainText(text.hint);
});

test("6 a row with usable banked resets shows the count, and an unknown claim shows Reset unknown", async ({ page }) => {
  const view = await frozen(page);
  const claude = providerOf(view, "anthropic").rows;
  const banked = claude.find(row => !pendingReset(row.resets) && usableGrant(row.resets));
  const pending = claude.find(row => pendingReset(row.resets));
  await openAccounts(page);
  await showProvider(page, "anthropic");
  expect(banked, "the fake seeds a Claude account with a usable reset").toBeTruthy();
  const left = usableGrant(banked!.resets)!.resetsLeft;
  await expect(accountRow(page, banked!).getByText(`${left} reset${left === 1 ? "" : "s"}`, { exact: true })).toBeVisible();
  expect(pending, "the fake seeds a Claude account with a pending reset claim").toBeTruthy();
  await expect(accountRow(page, pending!).getByText("Reset unknown", { exact: true })).toBeVisible();
});

test("7 with no thread the account the pool picks next says Next request", async ({ page }) => {
  const view = await frozen(page);
  const claude = providerOf(view, "anthropic");
  const next = claude.rows.find(row => row.id === claude.resolution?.account);
  test.skip(!next, "the fake names no next account for a new thread");
  // A pool pin makes the pool's pick a manual one, so the old chat's rule shows Manual on it instead.
  const badge = isManualAccount(claude, next!.id) ? "Manual" : "Next request";
  await openAccounts(page);
  await expect(accountRow(page, next!).getByText(badge, { exact: true })).toBeVisible();
  await expect(page.getByRole("row").getByText(badge, { exact: true })).toHaveCount(1);
  await expect(page.getByText("No thread is chosen. A new thread starts on the account marked Next request.")).toBeVisible();
  await expect(page.getByRole("row").getByText("Auto", { exact: true })).toHaveCount(0);
});

test("8 rows sort in use first, then pinned, ready, spent, refused, needs login and off", async ({ page }) => {
  const view = await frozen(page);
  await openAccounts(page);
  for (const provider of PROVIDERS) {
    await showProvider(page, provider);
    const expected = sortedRows(providerOf(view, provider)).map(row => row.label);
    const shown = await tableRows(page).allInnerTexts();
    expect(shown.length).toBe(expected.length);
    expected.forEach((label, index) => expect(shown[index], `row ${index + 1} of ${PROVIDER_LABEL[provider]}`).toContain(label));
  }
});

test("9 each row shows its plain-words notes", async ({ page }) => {
  // Every row and window of both providers, so this walk takes longer than one action.
  test.slow();
  const view = await frozen(page);
  await openAccounts(page);
  let notes = 0;
  for (const provider of PROVIDERS) {
    await showProvider(page, provider);
    for (const row of providerOf(view, provider).rows) {
      for (const note of rowNotes(row)) {
        // Countdowns in a note move with the clock, so the spec matches the words before the first number.
        const head = note.split(/\d/)[0]!.trim();
        await expect(accountRow(page, row).getByText(head).first(), `${row.label}: ${note}`).toBeVisible();
        notes++;
      }
    }
  }
  expect(notes).toBeGreaterThan(0);
});

test("10 countdowns tick every 30 seconds", async ({ page }) => {
  const base = await readView(page.request);
  const start = new Date("2026-10-30T03:00:00Z").getTime();
  await page.clock.install({ time: start });
  const row = makeRow("tick", { usageAt: start, windows: [{ kind: "session", label: "5h", pct: 40, resetsAt: start + (3 * 60 + 4) * 60_000 + 20_000 }] });
  await serveView(page, withProvider(base, "anthropic", { rows: [row], resolution: null, error: undefined }));
  await openAccounts(page);
  await showProvider(page, "anthropic");
  const line = accountRow(page, row);
  await expect(line).toContainText("resets in 3h 4m");
  await page.clock.runFor(31_000);
  await expect(line).toContainText("resets in 3h 3m");
});

test("11 the page shows loading, then Accounts unavailable with Retry, and Retry reads again", async ({ page }) => {
  let fail = true;
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/accounts", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    if (fail) {
      await held;
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "pi-pool snapshot timed out" }) });
    }
    return route.fallback();
  });
  await page.goto("/#/accounts");
  await expect(page.getByText("Loading accounts")).toBeVisible({ timeout: 15_000 });
  release();
  await expect(page.getByText(/Accounts unavailable/)).toBeVisible();
  await expect(page.getByText(/pi-pool snapshot timed out/)).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(providerTab(page, "anthropic")).toBeVisible();
});

test("11 a provider with no accounts says so, and a provider error shows the pool's message", async ({ page }) => {
  const base = await readView(page.request);
  let view = withProvider(base, "anthropic", { rows: [], resolution: null, error: undefined });
  await serveView(page, () => view);
  await openAccounts(page);
  await showProvider(page, "anthropic");
  await expect(page.getByText("No Claude accounts yet")).toBeVisible();
  view = withProvider(base, "anthropic", { rows: [], resolution: null, error: "pi-pool ls exited 2: config unreadable" });
  await page.reload();
  await showProvider(page, "anthropic");
  await expect(page.getByText("pi-pool ls exited 2: config unreadable")).toBeVisible({ timeout: 15_000 });
});

test("18 the pool meters show each provider's spent share and how many accounts take a new thread", async ({ page }) => {
  const view = await frozen(page);
  await openAccounts(page);
  for (const provider of view.providers.filter(entry => entry.rows.length)) {
    const summary = poolSummary(provider, poolCaps(view.poolConfig, view.priority));
    const card = page.getByTestId(`pool-meter-${provider.provider}`);
    await expect(card).toContainText(PROVIDER_LABEL[provider.provider]);
    await expect(card).toContainText(`${summary.usable}/${summary.total}`);
    for (const meter of summary.meters) {
      const label = meter.key === "week" ? "Week" : meter.key;
      await expect(card.getByRole("meter", { name: label, exact: true })).toBeVisible();
      await expect(card).toContainText(`${Math.round(meter.pct)}%`);
    }
  }
});

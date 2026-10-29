import { expect, test } from "@playwright/test";
import { resolutionSentence } from "../../web/src/pages/accounts/model.ts";
import { DM, escape, openAccounts, showProvider, providerOf, readView, serveView, withProvider, type AccountsView } from "./helpers.ts";

// A box with 80 busy cores slows a cold dev-server page, so each walk gets 60 s.
test.describe.configure({ timeout: 60_000 });

/**
 * The thread's sentence on `#/accounts?thread=<id>` (FEATURES.md 30), for every case the pool can answer. Each spec serves one reading,
 * the fake's own or a copy with the resolution changed, so the sentence never moves under it.
 */
async function threadView(page: import("@playwright/test").Page): Promise<AccountsView> {
  return readView(page.request, DM);
}

test("30 the sentence names the account Auto uses for the thread and why", async ({ page }) => {
  const view = await threadView(page);
  await serveView(page, view);
  await openAccounts(page, DM);
  await expect(page.getByText(resolutionSentence(providerOf(view, "anthropic")), { exact: true })).toBeVisible();
  await expect(page.getByText(/No thread is open/)).toHaveCount(0);
});

test("30 a manual pick says it holds the account for this thread or for all sessions", async ({ page }) => {
  const view = await threadView(page);
  const row = providerOf(view, "anthropic").rows[0]!;
  const manual = { account: row.id, email: row.email, reason: "session_pin", pinned: true, selection: { mode: "manual" as const, account_id: row.id }, error: null };
  let served = withProvider(view, "anthropic", { resolution: manual, wait: null, poolPin: null });
  await serveView(page, () => served);
  await openAccounts(page, DM);
  await expect(page.getByText(`Manual keeps ${row.label} selected for this thread.`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Auto/ })).toHaveAttribute("aria-pressed", "false");
  served = withProvider(view, "anthropic", { resolution: manual, wait: null, poolPin: row.id });
  await page.reload();
  await expect(page.getByText(`Manual keeps ${row.label} selected for all sessions.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Auto (pool override active)" })).toBeVisible();
});

test("30 a held thread says which account it waits for and when, and no account says so", async ({ page }) => {
  const view = await threadView(page);
  const row = providerOf(view, "anthropic").rows[0]!;
  const auto = { account: null, email: null, reason: null, pinned: false, selection: { mode: "auto" as const }, error: null };
  let served = withProvider(view, "anthropic", { resolution: auto, wait: { account: row.id, slotAt: Date.now() + 2 * 3600_000 } });
  await serveView(page, () => served);
  await openAccounts(page, DM);
  // With no account email to go by, the page picks the thread's provider from its model, which the agents list may not have loaded yet.
  await showProvider(page, "anthropic");
  await expect(page.getByText(new RegExp(`^Waiting for ${escape(row.label)}, back at \\d`))).toBeVisible();
  served = withProvider(view, "anthropic", { resolution: auto, wait: null });
  await page.reload();
  await showProvider(page, "anthropic");
  await expect(page.getByText("No Claude account can serve this thread right now.")).toBeVisible({ timeout: 15_000 });
});

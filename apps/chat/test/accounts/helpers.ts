import { expect, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import type { AccountLogin, AccountsView, PoolAccount, PoolProvider, UsageRefresh } from "../../web/src/lib/api/shared/types.ts";
import { accountState, type AccountState } from "../../web/src/pages/accounts/model.ts";

export type { AccountLogin, AccountsView, PoolAccount, PoolProvider, UsageRefresh };
export type ProviderId = PoolProvider["provider"];
export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: "Claude", "openai-codex": "Codex" };

/** Fixture threads (server/fixture/seed.ts): Vent's DM room and its agent. The server reads both as Vent's work thread. */
export const DM = "dm_vent";
export const AGENT = "ag_vent";

/** The fake pi-pool's view through the server, so each spec checks the page against the same data the page reads. */
export async function readView(request: APIRequestContext, thread: string | null = null, fresh = false): Promise<AccountsView> {
  const query = new URLSearchParams();
  if (thread) query.set("thread", thread);
  if (fresh) query.set("fresh", "1");
  const response = await request.get(`/api/accounts${query.size ? "?" + query : ""}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as AccountsView;
}

export const providerOf = (view: AccountsView, provider: ProviderId): PoolProvider => {
  const found = view.providers.find(entry => entry.provider === provider);
  expect(found, `the view has no ${provider} provider`).toBeTruthy();
  return found!;
};

/** The first row of `provider` in `state` (null is a ready account), or undefined when the fake seeds none. */
export const rowIn = (view: AccountsView, provider: ProviderId, state: AccountState | null, extra: (row: PoolAccount) => boolean = () => true): PoolAccount | undefined =>
  providerOf(view, provider).rows.find(row => accountState(row) === state && extra(row));

/** Resets the fake pi-pool to its seed when the fixture offers the hook (POST /api/fixture/pi-pool/reset); a fixture without it keeps its state. */
export async function resetPool(request: APIRequestContext): Promise<boolean> {
  const response = await request.post("/api/fixture/pi-pool/reset");
  return response.ok();
}

/** The fake pi-pool's raw state JSON (GET /api/fixture/pi-pool), or null when the fixture has no such hook. */
export async function poolState(request: APIRequestContext): Promise<Record<string, unknown> | null> {
  const response = await request.get("/api/fixture/pi-pool");
  return response.ok() ? ((await response.json()) as Record<string, unknown>) : null;
}

/**
 * Opens the Accounts tab, for one thread when `thread` is set. The box's Chrome sometimes drops a cold dev-server module load with
 * ERR_NETWORK_CHANGED, so a page that never mounts gets one reload.
 */
export async function openAccounts(page: Page, thread: string | null = null): Promise<void> {
  await page.goto(`/#/accounts${thread ? `?thread=${encodeURIComponent(thread)}` : ""}`);
  const ready = providerTab(page, "anthropic");
  try {
    await ready.waitFor({ timeout: 15_000 });
  } catch {
    await page.reload();
    await expect(ready).toBeVisible({ timeout: 15_000 });
  }
}

/** The provider's row in the Accounts sidebar, which names it and counts its accounts. */
export const providerTab = (page: Page, provider: ProviderId): Locator =>
  page.getByRole("navigation", { name: "Accounts" }).getByRole("link", { name: new RegExp(`^${PROVIDER_LABEL[provider]}\\b`) });

export async function showProvider(page: Page, provider: ProviderId): Promise<void> {
  await providerTab(page, provider).click();
  await expect(providerTab(page, provider)).toHaveAttribute("aria-current", "page");
}

/** One account's table row, found by its label shown on its own. */
export const accountRow = (page: Page, row: Pick<PoolAccount, "label">): Locator =>
  page.getByRole("row").filter({ has: page.getByText(row.label, { exact: true }) });

/** The table's account rows in the order shown, header excluded. */
export const tableRows = (page: Page): Locator => page.getByRole("row").filter({ has: page.getByRole("cell") });

/** Opens a row's More menu and returns it. */
export async function openMenu(page: Page, row: Pick<PoolAccount, "label">): Promise<Locator> {
  await page.getByRole("button", { name: `More actions for ${row.label}`, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

export const dialog = (page: Page): Locator => page.getByRole("dialog");

/** Waits for the account action POST that `act` sends and returns its body and answer. */
export async function postedAction<T = Record<string, unknown>, A = AccountsView>(page: Page, path: string, act: () => Promise<void>): Promise<{ body: T; status: number; answer: A }> {
  const [response] = await Promise.all([
    page.waitForResponse(answer => new URL(answer.url()).pathname === path && answer.request().method() === "POST", { timeout: 15_000 }),
    act(),
  ]);
  return { body: JSON.parse(response.request().postData() ?? "{}") as T, status: response.status(), answer: (await response.json()) as A };
}

/** Serves `view` for every GET /api/accounts and /api/pool, so a read-only spec sees one fixed pool while other specs act on the fake. */
export async function serveView(page: Page, view: AccountsView | ((url: URL) => AccountsView)): Promise<void> {
  const answer = (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(typeof view === "function" ? view(new URL(route.request().url())) : view) });
  };
  await page.route(url => url.pathname === "/api/accounts" || url.pathname === "/api/pool", answer);
  // A sign-in or usage read the actions spec runs is server-wide, and the page follows one it sees running, so a frozen page sees none.
  await page.route(url => url.pathname === "/api/accounts/login" || url.pathname === "/api/accounts/refresh", route =>
    route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: idleAnswer(route) }) : route.fallback());
}
const idleAnswer = (route: Route): string => (new URL(route.request().url()).pathname.endsWith("/login") ? "null" : "[]");

/** A copy of `view` with one provider's fields replaced, for a spec that needs a state the fake may not seed. */
export const withProvider = (view: AccountsView, provider: ProviderId, patch: Partial<PoolProvider>): AccountsView => ({
  ...view,
  providers: view.providers.map(entry => (entry.provider === provider ? { ...entry, ...patch } : entry)),
});

/** A plain ready account for a synthetic view. */
export function makeRow(id: string, patch: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id, email: `${id}@fixture.test`, label: `${id}@fixture.test`, plan: "max", usage: "", session_pct: 10, weekly_pct: 20, usable: true, reason: null,
    current: false, pinned: false, score: null, tier: null, usageAt: Date.now(), cooldownUntil: null, cooldownReason: null, disabled: false,
    limitedUntil: null, sessions: 0, resets: null,
    windows: [{ kind: "session", label: "5h", pct: 10, resetsAt: Date.now() + 3 * 3600_000 }, { kind: "weekly", label: "week", pct: 20, resetsAt: Date.now() + 4 * 86_400_000 }],
    ...patch,
  };
}

/** A conversation id of a live job in the fixture, from the server's own list. */
export async function firstJob(request: APIRequestContext): Promise<string | undefined> {
  const response = await request.get("/api/conversations");
  expect(response.ok()).toBe(true);
  const all = (await response.json()) as { id: string; kind: string; archived: boolean }[];
  return all.find(entry => entry.kind === "job" && !entry.archived)?.id;
}

export const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The account chip in a conversation's header (FEATURES.md 35): a button that starts with its mode, Auto or Manual. */
export const accountChip = (page: Page): Locator => page.locator("section.conversation").first().getByTestId("account-chip");

/** The chip's hint: its title, else the tooltip a hover shows. */
export async function hintOf(page: Page, target: Locator): Promise<string> {
  const title = await target.getAttribute("title");
  if (title) return title;
  await target.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  return (await tip.textContent()) ?? "";
}

/** Opens a conversation by its id and waits for its header. */
export async function openConversation(page: Page, id: string): Promise<void> {
  await page.goto(`/#/c/${encodeURIComponent(id)}`);
  const header = accountChip(page);
  try {
    await header.waitFor({ timeout: 15_000 });
  } catch {
    await page.reload();
    await expect(header).toBeVisible({ timeout: 15_000 });
  }
}

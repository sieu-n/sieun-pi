import { expect, test, type Page } from "@playwright/test";

type Kind = "input" | "output" | "cacheRead" | "cacheWrite";
type Row = { thread: string; threadName: string; host: string; model: string; turns: number; tokens: Record<Kind, number>; cost: Record<Kind | "total", number> };
type Report = { rows: Row[]; days: { start: number; byModel: Record<string, number> }[]; previous: { cost: number; complete: boolean } };

const KINDS: Kind[] = ["input", "output", "cacheRead", "cacheWrite"];
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const dollars = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n));

async function report(page: Page, days = 30, extra = ""): Promise<Report> {
  const response = await page.request.get(`/api/usage?days=${days}${extra}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Report;
}

function sums(rows: Row[]) {
  const tokens = Object.fromEntries(KINDS.map(kind => [kind, rows.reduce((sum, row) => sum + row.tokens[kind], 0)])) as Record<Kind, number>;
  const cost = Object.fromEntries([...KINDS, "total"].map(kind => [kind, rows.reduce((sum, row) => sum + row.cost[kind as Kind | "total"], 0)])) as Record<Kind | "total", number>;
  return { tokens, cost, turns: rows.reduce((sum, row) => sum + row.turns, 0), chats: new Set(rows.map(row => row.thread)).size };
}

test("the headline, turns and every token kind equal the server's rows exactly", async ({ page }) => {
  await page.goto("/#/settings/usage");
  await expect(page.getByTestId("usage-cost")).toBeVisible();
  const data = await report(page);
  test.skip(!data.rows.length, "no usage in the last 30 days on this server");
  const total = sums(data.rows);
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(total.cost.total));
  await expect(page.getByTestId("usage-turns")).toHaveText(whole(total.turns));
  for (const kind of KINDS) {
    const row = page.getByTestId(`usage-kind-${kind}`);
    await expect(row).toContainText(whole(total.tokens[kind]));
    await expect(row).toContainText(dollars(total.cost[kind]));
  }
  await expect(page.getByTestId("usage-summary")).toContainText(`${whole(total.turns)} turn`);
  const tokenTitle = await page.getByTestId("usage-tokens").getAttribute("title");
  expect(tokenTitle).toBe(`${whole(KINDS.reduce((sum, kind) => sum + total.tokens[kind], 0))} tokens`);
});

test("By chat lists every chat, costliest first, and a row opens its channel", async ({ page }) => {
  await page.goto("/#/settings/usage");
  const data = await report(page);
  test.skip(!data.rows.length, "no usage in the last 30 days on this server");
  const byThread = new Map<string, { name: string; cost: number }>();
  for (const row of data.rows) byThread.set(row.thread, { name: row.threadName, cost: (byThread.get(row.thread)?.cost ?? 0) + row.cost.total });
  const list = page.getByTestId("usage-by-chat").getByRole("link");
  await expect(list).toHaveCount(byThread.size);
  const first = [...byThread].sort((a, b) => b[1].cost - a[1].cost)[0]!;
  await expect(list.first()).toContainText(first[1].name);
  await list.first().click();
  await expect(page).toHaveURL(new RegExp(`#/c/${first[0]}$`));
});

test("the period and chat filters live in the URL and ask the server again", async ({ page }) => {
  await page.goto("/#/settings/usage");
  await expect(page.getByTestId("usage-filters")).toBeVisible();
  const asked = page.waitForRequest(request => request.url().includes("/api/usage?days=7"));
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("7");
  await asked;
  await expect(page).toHaveURL(/#\/settings\/usage\?days=7$/);
  await expect(page.getByText("Cost · last 7 days")).toBeVisible();

  const data = await report(page, 7);
  const threads = [...new Set(data.rows.map(row => row.thread))];
  test.skip(threads.length < 2, "the chat filter shows only with two chats or more");
  const pick = data.rows.find(row => row.thread === threads[1])!;
  await page.getByRole("combobox", { name: "Chat", exact: true }).selectOption(pick.thread);
  await expect(page).toHaveURL(new RegExp(`thread=${pick.thread}`));
  const only = await report(page, 7, `&thread=${pick.thread}`);
  await expect(page.getByTestId("usage-summary")).toContainText(pick.threadName);
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(sums(only.rows).cost.total));
});

test("each pool provider shows its accounts with their 5h and week meters", async ({ page }) => {
  await page.goto("/#/settings/usage");
  const pool = (await (await page.request.get("/api/pool")).json()) as { providers: { provider: string; rows: { id: string; usable: boolean; disabled: boolean; windows: { label: string; pct: number }[] }[] }[] };
  for (const provider of pool.providers.filter(entry => entry.rows.length)) {
    const live = provider.rows.filter(row => !row.disabled);
    await expect(page.getByTestId(`pool-${provider.provider}`)).toContainText(`${live.filter(row => row.usable).length}/${live.length}`);
    for (const row of provider.rows) {
      const card = page.getByTestId(`account-${row.id}`);
      await expect(card).toBeVisible();
      for (const window of row.windows) {
        const meter = card.getByRole("meter", { name: window.label === "week" ? "Week" : window.label, exact: true });
        await expect(meter).toHaveAttribute("aria-valuenow", String(window.pct));
      }
    }
  }
});

test("a failed read shows the reason and Try again reads again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/usage?*", route => (fail ? route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "pi-host did not answer" }) }) : route.continue()));
  await page.goto("/#/settings/usage");
  await expect(page.getByText("Usage isn't available")).toBeVisible();
  await expect(page.getByText("pi-host did not answer")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("usage-filters")).toBeVisible();
});

test("a period with no calls says so instead of showing zeros", async ({ page }) => {
  await page.route("**/api/usage?*", route =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ at: Date.now(), since: 0, until: Date.now(), rows: [], days: [], previous: { cost: 0, complete: true } }) }));
  await page.goto("/#/settings/usage");
  await expect(page.getByText("No usage in this period")).toBeVisible();
  await expect(page.getByTestId("usage-cost")).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";

type Kind = "input" | "output" | "cacheRead" | "cacheWrite";
type Row = { thread: string; threadName: string; host: string; model: string; turns: number; tokens: Record<Kind, number>; cost: Record<Kind | "total", number> };
type Bucket = { start: number; turns: number; tokens: Record<Kind, number>; cost: Record<Kind | "total", number>; byModel: Record<string, number> };
type Report = { range: string; bucket: string; rows: Row[]; buckets: Bucket[] };

const KINDS: Kind[] = ["input", "output", "cacheRead", "cacheWrite"];
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const dollars = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n));

async function report(page: Page, range = "24h", extra = ""): Promise<Report> {
  const response = await page.request.get(`/api/usage?range=${range}${extra}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Report;
}

function sums(rows: Row[]) {
  const tokens = Object.fromEntries(KINDS.map(kind => [kind, rows.reduce((sum, row) => sum + row.tokens[kind], 0)])) as Record<Kind, number>;
  const cost = Object.fromEntries([...KINDS, "total"].map(kind => [kind, rows.reduce((sum, row) => sum + row.cost[kind as Kind | "total"], 0)])) as Record<Kind | "total", number>;
  return { tokens, cost, turns: rows.reduce((sum, row) => sum + row.turns, 0), chats: new Set(rows.map(row => row.thread)).size };
}

test("the chart comes first, and its total, the figures and every token kind equal the server's rows exactly", async ({ page }) => {
  await page.goto("/#/settings/usage?range=7d&by=day");
  await expect(page.getByTestId("usage-cost")).toBeVisible();
  const data = await report(page, "7d", "&bucket=day");
  test.skip(!data.rows.length, "no usage in the last 7 days on this server");
  const total = sums(data.rows);
  const exact = `$${total.cost.total.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(total.cost.total));
  await expect(page.getByTestId("usage-kind-total")).toContainText(`${whole(total.turns)} turn`);
  for (const kind of KINDS) {
    const row = page.getByTestId(`usage-kind-${kind}`);
    await expect(row).toContainText(whole(total.tokens[kind]));
    await expect(row).toContainText(dollars(total.cost[kind]));
  }
  await expect(page.getByTestId("usage-chart-total")).toHaveAttribute("title", exact);
  await expect(page.getByTestId("usage-figures-total")).toHaveText(exact);
  await expect(page.getByTestId("usage-figures").locator("tbody tr")).toHaveCount(data.buckets.filter(b => b.turns > 0).length);
  await expect(page.getByText("Summed from every model call")).toHaveCount(0);
  const chartTop = (await page.getByRole("img", { name: "Cost per day" }).boundingBox())!.y;
  const kindsTop = (await page.getByTestId("usage-kind-input").boundingBox())!.y;
  expect(chartTop).toBeLessThan(kindsTop);
});

test("a hover names the bucket and its total, as its figures row has it", async ({ page }) => {
  await page.goto("/#/settings/usage?range=7d&by=day");
  const data = await report(page, "7d", "&bucket=day");
  test.skip(!data.rows.length, "no usage in the last 7 days on this server");
  const hit = page.getByTestId("usage-chart-hit");
  const box = (await hit.boundingBox())!;
  const index = data.buckets.findLastIndex(b => b.turns > 0);
  await page.mouse.move(box.x + (box.width / data.buckets.length) * (index + 0.5), box.y + box.height / 2);
  const tip = page.getByTestId("usage-chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(dollars(data.buckets[index]!.cost.total));
  await expect(tip).toContainText(`Turns${whole(data.buckets[index]!.turns)}`);
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

test("the range and the grouping live in the URL, ask the server again, and a range offers only its own groupings", async ({ page }) => {
  await page.goto("/#/settings/usage");
  await expect(page.getByTestId("usage-filters")).toBeVisible();
  const range = page.getByRole("tablist", { name: "Range" });
  const by = page.getByRole("tablist", { name: "Group by" });
  await expect(range.getByRole("tab", { name: "24h" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Hour" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-disabled", "true");

  let asked = page.waitForRequest(request => request.url().includes("/api/usage?range=24h&bucket=minute"));
  await by.getByRole("tab", { name: "Minute" }).click();
  await asked;
  await expect(page).toHaveURL(/#\/settings\/usage\?.*by=minute/);

  asked = page.waitForRequest(request => request.url().includes("/api/usage?range=30d&bucket=day"));
  await range.getByRole("tab", { name: "30d" }).click();
  await asked;
  await expect(by.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Minute" })).toHaveAttribute("aria-disabled", "true");

  const data = await report(page, "30d");
  const threads = [...new Set(data.rows.map(row => row.thread))];
  test.skip(threads.length < 2, "the chat filter shows only with two chats or more");
  const pick = data.rows.find(row => row.thread === threads[1])!;
  await page.getByRole("combobox", { name: "Chat", exact: true }).selectOption(pick.thread);
  await expect(page).toHaveURL(new RegExp(`thread=${pick.thread}`));
  const only = await report(page, "30d", `&thread=${pick.thread}`);
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(sums(only.rows).cost.total));
});

test("an old ?days=7 link opens the 7d range", async ({ page }) => {
  const asked = page.waitForRequest(request => request.url().includes("/api/usage?range=7d&bucket=hour"));
  await page.goto("/#/settings/usage?days=7");
  await asked;
  await expect(page.getByRole("tablist", { name: "Range" }).getByRole("tab", { name: "7d" })).toHaveAttribute("aria-selected", "true");
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
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ at: Date.now(), since: 0, until: Date.now(), range: "24h", bucket: "hour", rows: [], buckets: [] }) }));
  await page.goto("/#/settings/usage");
  await expect(page.getByText("No usage in this range")).toBeVisible();
  await expect(page.getByTestId("usage-cost")).toHaveCount(0);
});

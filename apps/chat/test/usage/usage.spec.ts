import { expect, test, type Page } from "@playwright/test";
import { fromColumns } from "../../web/src/lib/api/shared/usage-columns.ts";

type Kind = "input" | "output" | "cacheRead" | "cacheWrite";
type Row = { thread: string; threadName: string; host: string; client?: string; agent?: string; model: string; turns: number; unpriced?: number; tokens: Record<Kind, number>; cost: Record<Kind | "total", number> };
type Bucket = { start: number; turns: number; tokens: Record<Kind, number>; cost: Record<Kind | "total", number> };
type Report = { range: string; bucket: string; rows: Row[]; buckets: Bucket[] };

const KINDS: Kind[] = ["input", "output", "cacheRead", "cacheWrite"];
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
/** USD on the page's grid of a billionth of a dollar (format.ts), so a sum in this test's order rounds as the page's sum in its own order. */
const grid = (n: number) => Math.round(n * 1e9) / 1e9;
const dollars = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(grid(n)));

async function report(page: Page, range = "24h", extra = ""): Promise<Report> {
  const response = await page.request.get(`/api/usage?range=${range}${extra}`);
  expect(response.ok()).toBe(true);
  return fromColumns(await response.json()) as unknown as Report;
}

/**
 * The report the page itself reads for `query`, which it shows until its refresh a minute later (reports.ts `REFRESH_MS`). The fixture's
 * agents answer other specs' posts all the while, so a read of the test's own a moment later can count more turns than the screen does.
 */
function shown(page: Page, query: string): Promise<Report> {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/usage" && url.search === `?${query}`;
  }).then(async response => fromColumns(await response.json()) as unknown as Report);
}

/** The page's one chart, by its region "Cost per day" or "Output tokens per hour". */
const mainChart = (page: Page) => page.getByRole("region", { name: / per (minute|hour|day)$/ });

function sums(rows: Row[]) {
  const tokens = Object.fromEntries(KINDS.map(kind => [kind, rows.reduce((sum, row) => sum + row.tokens[kind], 0)])) as Record<Kind, number>;
  const cost = Object.fromEntries([...KINDS, "total"].map(kind => [kind, rows.reduce((sum, row) => sum + row.cost[kind as Kind | "total"], 0)])) as Record<Kind | "total", number>;
  return { tokens, cost, turns: rows.reduce((sum, row) => sum + row.turns, 0), chats: new Set(rows.map(row => row.thread)).size };
}

test("the chart comes first, and its total, the figures and every token kind equal the server's rows exactly", async ({ page }) => {
  const read = shown(page, "range=7d&bucket=day");
  await page.goto("/#/settings/usage?range=7d&by=day");
  await expect(page.getByTestId("usage-cost")).toBeVisible();
  const data = await read;
  test.skip(!data.rows.length, "no usage in the last 7 days on this server");
  const total = sums(data.rows);
  const exact = `$${grid(total.cost.total).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(total.cost.total));
  await expect(page.getByTestId("usage-kind-total")).toContainText(`${whole(total.turns)} turn`);
  for (const kind of KINDS) {
    const row = page.getByTestId(`usage-kind-${kind}`);
    await expect(row).toContainText(whole(total.tokens[kind]));
    await expect(row).toContainText(dollars(total.cost[kind]));
  }
  await expect(mainChart(page).getByTestId("usage-figures-total")).toHaveText(exact);
  await expect(mainChart(page).getByTestId("usage-figures").locator("tbody tr")).toHaveCount(data.buckets.filter(b => b.turns > 0).length);
  await expect(page.getByText("Summed from every model call")).toHaveCount(0);
  const chartTop = (await page.getByRole("img", { name: "Cost per day" }).boundingBox())!.y;
  const kindsTop = (await page.getByTestId("usage-kind-input").boundingBox())!.y;
  expect(chartTop).toBeLessThan(kindsTop);
});

test("a range whose sum sits on a half of a hundredth of a cent shows one exact total over the kinds and the chart's table", async ({ page }) => {
  // Three calls: $0.10 on one day, then $0.20 and $2.00005 on the next. Summed by chat rows the float sum is 2.3000499999999997, summed by day
  // buckets it is 2.30005, so the kinds and the chart's table printed $2.3000 and $2.3001 for the same calls before format.ts put them on one grid.
  const costs = [0.1, 0.2, 2.00005];
  const byRows = costs.reduce((sum, usd) => sum + usd, 0);
  const byBuckets = costs[0]! + (costs[1]! + costs[2]!);
  const four = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  expect([four(byRows), four(byBuckets)]).toEqual(["2.3000", "2.3001"]);

  const base = await report(page, "7d", "&bucket=day");
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const costOf = (usd: number) => ({ input: 0, output: usd, cacheRead: 0, cacheWrite: 0, total: usd });
  const model = "anthropic/claude-opus-5-5";
  const rows: Row[] = costs.map((usd, i) => ({ thread: `half-${i}`, threadName: `Half ${i}`, host: "fixture", model, turns: 1, tokens, cost: costOf(usd) }));
  const days = [[costs[0]!], [costs[1]!, costs[2]!]];
  const buckets = base.buckets.map((bucket, i) => {
    const day = days[i - (base.buckets.length - days.length)] ?? [];
    const usd = day.reduce((sum, value) => sum + value, 0);
    return { ...bucket, turns: day.length, tokens, cost: costOf(usd) };
  });
  const series = [{ key: model, cost: buckets.map(b => b.cost.total), tokens: buckets.map(() => 0), output: buckets.map(() => 0) }];
  await page.route("**/api/usage?range=7d&bucket=day*", route => route.fulfill({ json: { ...base, rows, buckets, split: "model", series } }));
  await page.goto("/#/settings/usage?range=7d&by=day");
  await expect(mainChart(page).getByTestId("usage-figures-total")).toHaveText("$2.3001");
  await expect(page.getByTestId("usage-kind-total")).toHaveAttribute("title", /, \$2\.3001$/);
  await expect(page.getByTestId("usage-kind-output")).toHaveAttribute("title", /, \$2\.3001$/);
});

test("the chart splits by client, By client lists each client on its host, and an unpriced call reads as unpriced, not free", async ({ page }) => {
  const base = await report(page, "7d", "&bucket=day");
  const tokens = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
  const costOf = (usd: number) => ({ input: usd / 2, output: usd / 2, cacheRead: 0, cacheWrite: 0, total: usd });
  const model = "anthropic/claude-opus-5-5";
  const row = (thread: string, client: string, host: string, usd: number, turns: number, unpriced: number): Row =>
    ({ thread, threadName: thread, host, client, agent: "", model, turns, unpriced, tokens, cost: costOf(usd) });
  const rows = [row("t1", "pi-host", "us-metal02", 3, 2, 0), row("s1", "codex", "mbp", 0, 4, 4), row("s2", "prime", "mbp", 1, 3, 1)];
  const last = base.buckets.length - 1;
  const buckets = base.buckets.map((bucket, i) => (i !== last ? { ...bucket, turns: 0, unpriced: 0, cost: costOf(0) } : {
    ...bucket, turns: 9, unpriced: 5, tokens: { input: 300, output: 150, cacheRead: 0, cacheWrite: 0 }, cost: costOf(4),
  }));
  const column = (value: number) => buckets.map((_, i) => (i === last ? value : 0));
  const byModel = [{ key: model, cost: column(4), tokens: column(450), output: column(150) }];
  const clientColumns = [["pi-host", 3], ["prime", 1], ["codex", 0]].map(([key, usd]) => ({ key: key as string, cost: column(usd as number), tokens: column(150), output: column(50) }));
  const asked: string[] = [];
  await page.route("**/api/usage?range=7d&bucket=day*", route => {
    const split = new URL(route.request().url()).searchParams.get("split") === "client";
    asked.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { ...base, rows, buckets, otherChats: 0, split: split ? "client" : "model", series: split ? clientColumns : byModel } });
  });
  await page.goto("/#/settings/usage?range=7d&by=day");
  const byClient = page.getByTestId("usage-by-client");
  await expect(byClient.locator("li")).toHaveCount(3);
  await expect(byClient.locator("li").first()).toContainText("pi-host");
  await expect(byClient.locator("li", { hasText: "codex" })).toContainText("Unpriced");
  await expect(byClient.locator("li", { hasText: "prime" })).toContainText("1 unpriced");
  await expect(page.getByTestId("usage-unpriced")).toContainText("5 of 9 turns");
  await expect(page.getByTestId("usage-cost")).toHaveText("$4.00");
  await page.getByRole("tablist", { name: "Split by" }).getByRole("tab", { name: "Client" }).click();
  await expect(page).toHaveURL(/split=client/);
  await expect(mainChart(page).getByRole("list", { name: "Clients" })).toContainText("codex");
  expect(asked.some(query => query.includes("split=client")), "a client split asks the server for that split's columns").toBe(true);
  await page.getByRole("combobox", { name: "Client" }).selectOption("codex");
  await expect(page).toHaveURL(/client=codex/);
});

test("the page draws one chart, with tokens per second now in its header row, and the unit and token kind toggles drive both", async ({ page }) => {
  const spark = (top: number) => Array.from({ length: 61 }, (_, i) => (top * i) / 60);
  let live = { at: Date.now(), perSecond: { total: 1234, output: 56.7 }, spark: { total: spark(1234), output: spark(56.7) } };
  await page.route("**/api/usage/live?*", route => route.fulfill({ json: live }));
  await page.route("**/api/usage/live", route => route.fulfill({ json: live }));
  const read = shown(page, "range=7d&bucket=day");
  await page.goto("/#/settings/usage?range=7d&by=day");
  test.skip(!(await read).rows.length, "no usage in the last 7 days on this server");
  const chart = mainChart(page);
  await expect(chart.getByRole("img", { name: "Cost per day", exact: true })).toBeVisible();
  await expect(page.getByTestId("usage-chart-hit")).toHaveCount(1);
  await expect(page.getByTestId("usage-figures")).toHaveCount(1);
  await expect(page.getByText("Tokens per second", { exact: true })).toHaveCount(0);

  const readout = chart.getByTestId("usage-tps");
  await expect(readout).toContainText("Tokens / s");
  await expect(readout.getByTestId("usage-tps-value")).toHaveText("1.2K", { timeout: 10_000 });
  await expect(readout.getByTestId("usage-tps-other")).toHaveText("out 56.7");
  await expect(readout.getByTestId("usage-tps-spark")).toBeVisible();
  live = { at: Date.now(), perSecond: { total: 42, output: 3 }, spark: { total: spark(42), output: spark(3) } };
  await expect(readout.getByTestId("usage-tps-value")).toHaveText("42.0", { timeout: 10_000 });
});

test("the unit and token kind toggles switch the chart and the tokens per second readout together", async ({ page }) => {
  const live = { at: Date.now(), perSecond: { total: 42, output: 3 }, spark: { total: [0, 42], output: [0, 3] } };
  await page.route("**/api/usage/live?*", route => route.fulfill({ json: live }));
  await page.route("**/api/usage/live", route => route.fulfill({ json: live }));
  const read = shown(page, "range=7d&bucket=day");
  await page.goto("/#/settings/usage?range=7d&by=day&metric=output");
  test.skip(!(await read).rows.length, "no usage in the last 7 days on this server");
  const chart = mainChart(page);
  const readout = chart.getByTestId("usage-tps");
  await expect(readout).toContainText("Output / s");
  await expect(readout.getByTestId("usage-tps-value")).toHaveText("3.0", { timeout: 10_000 });
  await expect(readout.getByTestId("usage-tps-other")).toHaveText("total 42.0");
  await page.getByRole("tablist", { name: "Unit" }).getByRole("tab", { name: "Tokens" }).click();
  await expect(page).toHaveURL(/unit=tokens/);
  await expect(chart.getByRole("img", { name: "Output tokens per day", exact: true })).toBeVisible();
  await page.getByRole("tablist", { name: "Token kind" }).getByRole("tab", { name: "Total" }).click();
  await expect(chart.getByRole("img", { name: "Tokens per day", exact: true })).toBeVisible();
  await expect(readout.getByTestId("usage-tps-value")).toHaveText("42.0");
  await page.getByRole("tablist", { name: "Unit" }).getByRole("tab", { name: "$" }).click();
  await expect(chart.getByRole("img", { name: "Cost per day", exact: true })).toBeVisible();
  await expect(page.getByTestId("usage-chart-hit")).toHaveCount(1);
});

test("a hover names the bucket and its total, as its figures row has it", async ({ page }) => {
  const read = shown(page, "range=7d&bucket=day");
  await page.goto("/#/settings/usage?range=7d&by=day");
  const data = await read;
  test.skip(!data.rows.length, "no usage in the last 7 days on this server");
  const hit = mainChart(page).getByTestId("usage-chart-hit");
  const box = (await hit.boundingBox())!;
  const index = data.buckets.findLastIndex(b => b.turns > 0);
  await page.mouse.move(box.x + (box.width / data.buckets.length) * (index + 0.5), box.y + box.height / 2);
  const tip = page.getByTestId("usage-chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(dollars(data.buckets[index]!.cost.total));
  await expect(tip).toContainText(`Turns${whole(data.buckets[index]!.turns)}`);
});

test("By chat shows the 10 costliest chats, Show all lists every chat, and a row opens its channel", async ({ page }) => {
  const base = await report(page, "24h");
  const model = "anthropic/claude-opus-5-5";
  const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const rows = Array.from({ length: 12 }, (_, i) => ({ thread: `chat-${i}`, threadName: `chat ${i}`, host: "us-metal02", client: "pi-host", agent: "", model, turns: 1,
    unpriced: 0, tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: i + 1 } }));
  await page.route("**/api/usage?range=24h&bucket=hour*", route => route.fulfill({ json: { ...base, rows, otherChats: 0 } }));
  await page.goto("/#/settings/usage");
  // The list shows the 10 costliest chats and a "Show all" button for the rest (UsagePage.svelte `CHATS_SHOWN`, c123).
  const list = page.getByTestId("usage-by-chat").getByRole("link");
  await expect(list).toHaveCount(10);
  await expect(list.first()).toContainText("chat 11");
  await expect(list.last()).toContainText("chat 2");
  await page.getByRole("button", { name: "Show all 12" }).click();
  await expect(list).toHaveCount(12);
  await list.first().click();
  await expect(page).toHaveURL(/#\/c\/chat-11$/);
});

test("the range and the grouping live in the URL, ask the server again, and a range offers only its own groupings", async ({ page }) => {
  await page.goto("/#/settings/usage");
  await expect(page.getByTestId("usage-filters")).toBeVisible();
  const range = page.getByRole("tablist", { name: "Range" });
  const by = page.getByRole("tablist", { name: "Group by" });
  await expect(range.getByRole("tab", { name: "24h" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Hour" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-disabled", "true");

  await by.getByRole("tab", { name: "Minute" }).click();
  await expect(page).toHaveURL(/#\/settings\/usage\?.*by=minute/);
  await expect(page.locator('section[aria-label$=" per minute"]')).toBeVisible();

  await range.getByRole("tab", { name: "30d" }).click();
  await expect(page.locator('section[aria-label$=" per day"]')).toBeVisible();
  await expect(by.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-selected", "true");
  await expect(by.getByRole("tab", { name: "Minute" })).toHaveAttribute("aria-disabled", "true");

  const data = await report(page, "30d");
  const threads = [...new Set(data.rows.map(row => row.thread))];
  test.skip(threads.length < 2, "the chat filter shows only with two chats or more");
  const pick = data.rows.find(row => row.thread === threads[1])!;
  const picked = shown(page, `range=30d&bucket=day&thread=${pick.thread}`);
  await page.getByRole("combobox", { name: "Chat", exact: true }).selectOption(pick.thread);
  await expect(page).toHaveURL(new RegExp(`thread=${pick.thread}`));
  const only = await picked;
  await expect(page.getByTestId("usage-cost")).toHaveText(dollars(sums(only.rows).cost.total));
});

test("the page reads every other range ahead, so a pick shows its chart with no wait and reads it again behind", async ({ page }) => {
  const ahead = ["range=1h&bucket=minute", "range=24h&bucket=minute", "range=7d&bucket=hour", "range=7d&bucket=day", "range=30d&bucket=day", "range=30d&bucket=hour", "range=90d&bucket=day"];
  const read = ahead.map(q => page.waitForResponse(response => response.url().includes(`/api/usage?${q}`)));
  await page.goto("/#/settings/usage");
  await expect(page.getByTestId("usage-filters")).toBeVisible();
  const responses = await Promise.all(read);
  const data = fromColumns(await responses[ahead.indexOf("range=7d&bucket=day")]!.json()) as unknown as Report;
  test.skip(!data.rows.length, "no usage in the last 7 days on this server");
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await page.route("**/api/usage?range=7d*", async route => {
    await held;
    await route.continue();
  });
  await page.getByRole("tablist", { name: "Range" }).getByRole("tab", { name: "7d" }).click();
  await page.getByRole("tablist", { name: "Group by" }).getByRole("tab", { name: "Day" }).click();
  await expect(page.locator('section[aria-label$=" per day"]')).toBeVisible();
  await expect(mainChart(page).getByTestId("usage-figures").locator("tbody tr")).toHaveCount(data.buckets.filter(b => b.turns > 0).length);
  release();
});

/** The reports with no filter the page stored in IndexedDB (reports.ts), by key such as "24h:hour". */
const storedReports = (page: Page) => page.evaluate(() => new Promise<string[]>(resolve => {
  const open = indexedDB.open("chat.usage");
  open.onsuccess = () => {
    const keys = open.result.transaction("reports").objectStore("reports").getAllKeys();
    keys.onsuccess = () => resolve(keys.result.map(String).sort());
    keys.onerror = () => resolve([]);
  };
  open.onerror = () => resolve([]);
}));

test("each other range is read ahead once and stored, so a page load or a minute's refresh reads only the report on screen", async ({ page }) => {
  await page.clock.install();
  const asked: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/usage") asked.push(url.search);
  });
  await page.goto("/#/settings/usage");
  await expect(mainChart(page)).toBeVisible();
  const all = ["1h:minute", "24h:hour", "24h:minute", "30d:day", "30d:hour", "7d:day", "7d:hour", "90d:day"].map(key => `${key}:model`);
  // The lane sends reads ahead 2 at a time behind the sidebar's (client.ts `AHEAD_LANE`), and they settle 11.5 s after a load in the walk of
  // ~/work/p155-readahead/lane-summary.md. At box load 313 on 11-23 only 5 of the 7 had left 6 s after the chart drew
  // (~/work/chat-specs-red/specs-red-usage-usage/notes.md).
  await expect.poll(() => storedReports(page), { timeout: 15_000 }).toEqual(all);

  asked.length = 0;
  await page.clock.runFor(61_000);
  await expect.poll(() => asked).toEqual(["?range=24h&bucket=hour"]);
  await page.clock.runFor(3_000);
  expect(asked).toEqual(["?range=24h&bucket=hour"]);

  asked.length = 0;
  await page.reload();
  await expect(mainChart(page)).toBeVisible();
  await expect.poll(() => asked).toEqual(["?range=24h&bucket=hour"]);
  await page.clock.runFor(3_000);
  expect(asked).toEqual(["?range=24h&bucket=hour"]);
});

test("a page load draws the report the last load stored at once, names its time, and reads the latest behind it", async ({ page }) => {
  await page.goto("/#/settings/usage");
  await expect(mainChart(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const open = indexedDB.open("chat.usage");
    open.onsuccess = () => {
      const get = open.result.transaction("reports").objectStore("reports").get("24h:hour:model");
      get.onsuccess = () => resolve(get.result !== undefined);
      get.onerror = () => resolve(false);
    };
    open.onerror = () => resolve(false);
  }))).toBe(true);
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await page.route("**/api/usage?range=24h&bucket=hour*", async route => {
    await held;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator('section[aria-label$=" per hour"]')).toBeVisible();
  await expect(page.getByTestId("usage-as-of")).toContainText("As of");
  release();
  await expect(page.getByTestId("usage-as-of")).toHaveCount(0);
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

/**
 * Keeps the live socket silent, so the page reads the pool only over HTTP: a read at the socket's open goes over it (kept.svelte.ts
 * `readOverSocket`). The page drops a socket that answers no ping and opens a new one (live.svelte.ts `QUIET_MS`, `PONG_WITHIN_MS`), so an
 * open pool panel reads /api/pool again over HTTP every 4 to 5 s (the trace in ~/work/chat-specs-red/specs-red-usage-usage/notes.md).
 */
const noSocket = (page: Page) => page.routeWebSocket(/\/api\/live/, () => {});
const isPool = (url: URL): boolean => url.pathname === "/api/pool";
const poolCard = (page: Page) => page.locator('[data-testid="pool-anthropic"], [data-testid="pool-openai-codex"]').first();

test("a visit draws the pool the last visit read at once, names its time while it is older than a poll, and reads it again behind", async ({ page }) => {
  await noSocket(page);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  let release = () => {};
  let held: Promise<void> | undefined;
  let answered = 0;
  // One route for the whole test, as the page reads the pool every few seconds (`noSocket`): a read between a swap of routes and the reload
  // stored the server's own time, and the reload drew the pool with no time named.
  await page.route(isPool, async route => {
    try {
      if (!held) {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...((await response.json()) as object), checkedAt: hourAgo } });
        return;
      }
      await held;
      await route.continue();
      answered += 1;
    } catch {
      // A read of the page before the reload, which the reload cancelled.
    }
  });
  await page.goto("/#/settings/usage");
  await expect(poolCard(page)).toBeVisible();
  await expect(page.getByTestId("usage-pool-as-of")).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>(resolve => {
    const open = indexedDB.open("chat.pages");
    open.onsuccess = () => {
      const get = open.result.transaction("pages").objectStore("pages").get(["kept", "/api/pool"]);
      get.onsuccess = () => resolve((get.result as { value?: { checkedAt?: string } } | undefined)?.value?.checkedAt);
      get.onerror = () => resolve(undefined);
    };
    open.onerror = () => resolve(undefined);
  }))).toBe(hourAgo);
  held = new Promise<void>(resolve => (release = resolve));
  await page.reload();
  await expect(poolCard(page)).toBeVisible();
  await expect(page.getByTestId("usage-pool-as-of")).toBeVisible();
  expect(answered).toBe(0);
  release();
  await expect.poll(() => answered).toBeGreaterThan(0);
  await expect(page.getByTestId("usage-pool-as-of")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
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

test("sums the store has not refreshed name their time, and the live rate reads as unknown, not 0", async ({ page }) => {
  const base = await report(page, "24h");
  const staleSince = Date.UTC(2026, 10, 24, 2, 19);
  await page.route("**/api/usage?range=24h&bucket=hour*", route => route.fulfill({ json: { ...base, staleSince, live: { ...(base as unknown as { live: object }).live, staleSince } } }));
  await page.route("**/api/usage/live*", route => route.fulfill({ json: { at: Date.now(), perSecond: { output: 0, total: 0 }, spark: { output: [], total: [] }, staleSince } }));
  await page.goto("/#/settings/usage");
  const clock = new Date(staleSince).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  await expect(page.getByTestId("usage-stale")).toHaveText(`Numbers from ${clock}; the store did not answer since`);
  await expect(page.getByTestId("usage-tps-stale")).toContainText(clock);
  await expect(page.getByTestId("usage-tps-value")).toHaveCount(0);
});

test("a period with no calls says so instead of showing zeros", async ({ page }) => {
  await page.route("**/api/usage?*", route =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ at: Date.now(), since: 0, until: Date.now(), range: "24h", bucket: "hour", rows: [], buckets: [] }) }));
  await page.goto("/#/settings/usage");
  await expect(page.getByText("No usage in this range")).toBeVisible();
  await expect(page.getByTestId("usage-cost")).toHaveCount(0);
});

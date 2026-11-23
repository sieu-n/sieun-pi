import { expect, test, type Page } from "@playwright/test";

type Status = "working" | "idle" | "sleeping" | "failed";
type Counts = Record<Status, number>;
type Thread = { id: string; name: string; status: Status; model?: string | null; updatedAt?: number; children?: number; test?: true };
type Host = {
  name: string; address: string; self: boolean;
  relay: { state: "up"; pingMs: number } | { state: "unreachable"; error: string };
  piHost: { state: "answering"; version: string; socket?: string } | { state: "down"; error: string } | { state: "absent" };
  agentRelay?: { state: "up" | "away"; since: number; lastPongAt: number | null; version: string | null; piHost: { up: boolean; version?: string } | null; feedCursor: number } | null;
  machine: { cpu: { percent: number }; memory: { usedBytes: number; totalBytes: number } } | null;
  counts: { real: Counts; test: Counts };
  threads: Thread[];
};
type Report = { checkedAt: number; registryError: string | null; hosts: Host[] };

const STATUSES: readonly Status[] = ["working", "idle", "sleeping", "failed"];
const total = (counts: Counts): number => STATUSES.reduce((sum, status) => sum + counts[status], 0);
const isHosts = (url: URL): boolean => url.pathname === "/api/hosts";
const noThreads = { counts: { real: { working: 0, idle: 0, sleeping: 0, failed: 0 }, test: { working: 0, idle: 0, sleeping: 0, failed: 0 } }, threads: [] };

/** Keeps the live socket shut, so the page reads the hosts only over HTTP: a read at the socket's open goes over it (kept.svelte.ts `readOverSocket`). */
const noSocket = (page: Page) => page.routeWebSocket(/\/api\/live/, () => {});

/** Serve /api/hosts as the fixture does, with `change` applied to its report and the read's query. */
async function withHosts(page: Page, change: (data: Report, query: URLSearchParams) => Report): Promise<void> {
  await noSocket(page);
  await page.route(isHosts, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as Report, new URL(route.request().url()).searchParams) });
  });
}

/** A box holding `threads`, counted and listed as the server does for the read's query (server/usage.ts `hostsReport`). */
function holding(host: Host, threads: Thread[], query: URLSearchParams, listed: boolean): Host {
  const counts = { real: { working: 0, idle: 0, sleeping: 0, failed: 0 }, test: { working: 0, idle: 0, sleeping: 0, failed: 0 } };
  for (const thread of threads) counts[thread.test ? "test" : "real"][thread.status] += 1;
  const filter = query.get("threads") ?? "working";
  const shown = listed ? threads.filter(thread => (!thread.test || query.get("tests") === "1") && (filter === "all" || thread.status === filter)) : [];
  return { ...host, counts, threads: shown.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) };
}

test("every box has a row with its figures, the picked box shows its services and threads, and a thread opens its channel", async ({ page }) => {
  await page.goto("/#/settings/hosts");
  await expect(page.getByTestId("hosts-list")).toBeVisible();
  const data = (await (await page.request.get("/api/hosts")).json()) as Report;
  for (const host of data.hosts) {
    const row = page.getByTestId(`host-row-${host.name}`);
    await expect(row).toContainText(host.name);
    if (host.self) await expect(row.getByText("This box", { exact: true })).toBeVisible();
    if (host.machine) await expect(row.getByRole("meter", { name: "Memory" })).toBeVisible();
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    const detail = page.getByTestId(`host-${host.name}`);
    await expect(detail.getByRole("heading", { name: host.name, exact: true })).toBeVisible();
    await expect(detail.getByText("pi-host", { exact: true })).toBeVisible();
    if (host.piHost.state === "absent") continue;
    await detail.getByRole("tab", { name: `All ${total(host.counts.real)}`, exact: true }).click();
    const all = (await (await page.request.get(`/api/hosts?box=${encodeURIComponent(host.name)}&threads=all`)).json()) as Report;
    const listed = all.hosts.find(h => h.name === host.name)!.threads;
    expect(listed).toHaveLength(total(host.counts.real));
    for (const thread of listed) await expect(detail.getByTestId(`host-thread-${thread.id}`)).toContainText(thread.name);
  }
  const owner = data.hosts.find(host => total(host.counts.real));
  test.skip(!owner, "no threads on any pi-host");
  const first = ((await (await page.request.get(`/api/hosts?box=${encodeURIComponent(owner!.name)}&threads=all`)).json()) as Report).hosts.find(h => h.name === owner!.name)!.threads[0]!;
  await page.getByTestId(`host-row-${owner!.name}`).click();
  await page.getByTestId(`host-${owner!.name}`).getByRole("tab", { name: /^All / }).click();
  await page.getByTestId(`host-thread-${first.id}`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${first.id}$`));
});

test("the thread list shows working threads first with an exact count on every status tab, and test threads only when asked", async ({ page }) => {
  const statuses: Status[] = ["working", "working", "failed", "idle", "idle", "idle"];
  await withHosts(page, (data, query) => {
    const [first, ...rest] = data.hosts;
    const threads: Thread[] = statuses.map((status, index) => ({ id: `t-${index}`, name: `thread ${index}`, status, model: null, updatedAt: data.checkedAt - index * 1000, children: 0 }));
    threads.push({ id: "t-walk-1", name: "walk 1", status: "working", model: null, updatedAt: data.checkedAt, children: 0, test: true });
    threads.push({ id: "t-walk-2", name: "walk 2", status: "idle", model: null, updatedAt: data.checkedAt, children: 0, test: true });
    const self = holding({ ...first!, self: true, piHost: { state: "answering", version: "0.1.0" } }, threads, query, !query.get("box") || query.get("box") === first!.name);
    return { ...data, hosts: [self, ...rest.map(host => ({ ...host, ...noThreads, self: false }))] };
  });
  await page.goto("/#/settings/hosts");
  const row = page.locator('[data-testid^="host-row-"]').first();
  await expect(row).toContainText("6");
  await expect(row).toContainText("2 working");
  const detail = page.locator('[data-testid^="host-"][aria-label]').first();
  for (const name of ["Working 2", "Failed 1", "Idle 3", "All 6"]) await expect(detail.getByRole("tab", { name, exact: true })).toBeVisible();
  await expect(detail.getByRole("tab", { name: /^Sleeping/ })).toHaveCount(0);
  await expect(detail.locator('[data-testid^="host-thread-"]')).toHaveCount(2);
  await detail.getByRole("tab", { name: "All 6", exact: true }).click();
  await expect(detail.locator('[data-testid^="host-thread-"]')).toHaveCount(6);
  await expect(detail.getByTestId("host-thread-t-walk-1")).toHaveCount(0);
  await detail.getByText("Show 2 test threads").click();
  await expect(detail.getByRole("tab", { name: "All 8", exact: true })).toBeVisible();
  await expect(detail.getByRole("tab", { name: "Working 3", exact: true })).toBeVisible();
  await expect(detail.getByTestId("host-thread-t-walk-1")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("each 2 s poll carries only the threads the picked tab shows, and a box with a thousand threads still lists them all on All", async ({ page }) => {
  const asked: string[] = [];
  const many: Thread[] = Array.from({ length: 1200 }, (_, index) => ({ id: `t-${index}`, name: `thread ${index}`, status: index < 3 ? "working" : "idle", model: null, updatedAt: 1_000_000 - index, children: 0 }));
  await withHosts(page, (data, query) => {
    asked.push(query.toString());
    const [first, ...rest] = data.hosts;
    const self = holding({ ...first!, self: true, piHost: { state: "answering", version: "0.1.0" } }, many, query, !query.get("box") || query.get("box") === first!.name);
    return { ...data, hosts: [self, ...rest.map(host => ({ ...host, ...noThreads, self: false }))] };
  });
  const polled = page.waitForResponse(response => isHosts(new URL(response.url())));
  await page.goto("/#/settings/hosts");
  const body = await (await polled).json() as Report;
  expect(body.hosts[0]!.threads).toHaveLength(3);
  const detail = page.locator('[data-testid^="host-"][aria-label]').first();
  await expect(detail.locator('[data-testid^="host-thread-"]')).toHaveCount(3);
  await expect(detail.getByRole("tab", { name: "All 1200", exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "All 1200", exact: true }).click();
  await expect(detail.locator('[data-testid^="host-thread-"]')).toHaveCount(1200);
  expect(asked).toContain("threads=all");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a reload draws the hosts the last visit read at once and reads them again behind", async ({ page }) => {
  await noSocket(page);
  await page.goto("/#/settings/hosts");
  await expect(page.getByTestId("hosts-list")).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const open = indexedDB.open("chat.pages");
    open.onsuccess = () => {
      const get = open.result.transaction("pages").objectStore("pages").get(["kept", "/api/hosts"]);
      get.onsuccess = () => resolve(get.result !== undefined);
      get.onerror = () => resolve(false);
    };
    open.onerror = () => resolve(false);
  }))).toBe(true);
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  let answered = 0;
  await page.route(isHosts, async route => {
    await held;
    await route.continue();
    answered += 1;
  });
  await page.reload();
  await expect(page.getByTestId("hosts-list")).toBeVisible();
  await expect(page.locator('[data-testid^="host-row-"]').first()).toBeVisible();
  expect(answered).toBe(0);
  release();
  await expect.poll(() => answered).toBeGreaterThan(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a box's actions menu refreshes it and copies its address", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/settings/hosts");
  const detail = page.locator('[data-testid^="host-"][aria-label]').first();
  await detail.getByRole("button", { name: "Host actions" }).click();
  const menu = page.getByRole("menu", { name: "Host actions" });
  await expect(menu.getByRole("menuitem", { name: /Refresh/ })).toBeVisible();
  const reread = page.waitForRequest(request => isHosts(new URL(request.url())));
  await menu.getByRole("menuitem", { name: /Refresh/ }).click();
  await reread;
  await detail.getByRole("button", { name: "Host actions" }).click();
  await page.getByRole("menu", { name: "Host actions" }).getByRole("menuitem", { name: /Copy address/ }).click();
  await expect(page.getByText("Address copied")).toBeVisible();
  const data = (await (await page.request.get("/api/hosts")).json()) as Report;
  const self = data.hosts.find(host => host.self) ?? data.hosts[0]!;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(self.address);
});

test("the page reads the hosts again every 2 seconds", async ({ page }) => {
  await page.goto("/#/settings/hosts");
  await page.waitForRequest(request => isHosts(new URL(request.url())));
  const started = Date.now();
  await page.waitForRequest(request => isHosts(new URL(request.url())));
  expect(Date.now() - started).toBeLessThan(3500);
});

test("a box that does not answer says so, never zeros, a down pi-host is named, and the raw error stays in the tooltip", async ({ page }) => {
  await withHosts(page, data => {
    const [first, ...rest] = data.hosts;
    const away: Host = { name: "far-box", address: "100.64.0.9", self: false, relay: { state: "unreachable", error: "connect ETIMEDOUT" }, piHost: { state: "absent" }, machine: null, ...noThreads };
    const down: Host = { ...first!, piHost: { state: "down", error: "socket refused" } };
    return { ...data, hosts: [down, ...rest, away] };
  });
  await page.goto("/#/settings/hosts");
  const far = page.getByTestId("host-row-far-box");
  await expect(far.getByText("Not answering", { exact: true })).toBeVisible();
  await expect(far.getByRole("meter")).toHaveCount(0);
  await expect(page.getByText("connect ETIMEDOUT")).toHaveCount(0);
  await far.getByText("Not answering", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("connect ETIMEDOUT");
  await expect(page.locator('[data-testid^="host-row-"]').first().getByText("pi-host down", { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a failed hosts read shows the reason and Try again", async ({ page }) => {
  let fail = true;
  await noSocket(page);
  await page.route(isHosts, route => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "hosts.json unreadable" }) }) : route.continue()));
  await page.goto("/#/settings/hosts");
  await expect(page.getByText("Hosts didn't load")).toBeVisible();
  await expect(page.getByText("hosts.json unreadable")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("hosts-list")).toBeVisible();
});

test("a box's agent relay link shows up with its last pong, away with the hello it last heard, and the feed cursor in its tooltip", async ({ page }) => {
  await withHosts(page, data => {
    const now = data.checkedAt;
    const linked: Host = {
      name: "linked-box", address: "100.64.0.10", self: false, relay: { state: "unreachable", error: "no machine relay" }, piHost: { state: "answering", version: "0.1.0" },
      agentRelay: { state: "up", since: now - 600_000, lastPongAt: now - 4_000, version: "0.1.0", piHost: { up: true, version: "0.1.0" }, feedCursor: 7 }, machine: null, ...noThreads,
    };
    const away: Host = {
      ...linked, name: "away-box", piHost: { state: "down", error: "away-box is offline" },
      agentRelay: { state: "away", since: now - 20_000, lastPongAt: now - 31_000, version: "0.1.0", piHost: { up: true, version: "0.1.0" }, feedCursor: 7 },
    };
    return { ...data, hosts: [...data.hosts, linked, away] };
  });
  await page.goto("/#/settings/hosts");
  await page.getByTestId("host-row-linked-box").click();
  const linked = page.getByTestId("agent-relay-linked-box");
  await expect(linked).toContainText("Linked since");
  await expect(linked).toContainText("pong 4 s ago");
  await linked.getByText(/^Linked since/).hover();
  await expect(page.getByRole("tooltip")).toHaveText("relay 0.1.0 · feed cursor 7");
  await expect(page.getByTestId("host-row-away-box")).toContainText("Offline, last seen");
  await page.getByTestId("host-row-away-box").click();
  const away = page.getByTestId("host-away-box");
  await expect(away.getByTestId("agent-relay-away-box")).toContainText("Away since");
  await expect(away.getByTestId("agent-relay-away-box")).toContainText("pong 31 s ago");
  await expect(away.getByText("Posts to its agents wait until the box is back.")).toBeVisible();
  await expect(away.getByText("Last heard up, 0.1.0")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

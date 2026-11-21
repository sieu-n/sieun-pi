import { expect, test, type Page } from "@playwright/test";

type Thread = { id: string; name: string; status: string; model?: string | null; updatedAt?: number; children?: number; test?: true };
type Host = {
  name: string; address: string; self: boolean;
  relay: { state: "up"; pingMs: number } | { state: "unreachable"; error: string };
  piHost: { state: "answering"; version: string; socket?: string } | { state: "down"; error: string } | { state: "absent" };
  agentRelay?: { state: "up" | "away"; since: number; lastPongAt: number | null; version: string | null; piHost: { up: boolean; version?: string } | null; feedCursor: number } | null;
  machine: { cpu: { percent: number }; memory: { usedBytes: number; totalBytes: number } } | null;
  threads: Thread[];
};
type Report = { checkedAt: number; registryError: string | null; hosts: Host[] };

/** Serve /api/hosts as the fixture does, with `change` applied to its report. */
const withHosts = (page: Page, change: (data: Report) => Report) =>
  page.route("**/api/hosts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as Report) });
  });

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
    await detail.getByRole("tab", { name: `All ${host.threads.length}`, exact: true }).click();
    for (const thread of host.threads) await expect(detail.getByTestId(`host-thread-${thread.id}`)).toContainText(thread.name);
  }
  const owner = data.hosts.find(host => host.threads.length);
  test.skip(!owner, "no threads on any pi-host");
  const first = owner!.threads[0]!;
  await page.getByTestId(`host-row-${owner!.name}`).click();
  await page.getByTestId(`host-${owner!.name}`).getByRole("tab", { name: /^All / }).click();
  await page.getByTestId(`host-thread-${first.id}`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${first.id}$`));
});

test("the thread list shows working threads first with an exact count on every status tab, and test threads only when asked", async ({ page }) => {
  const statuses = ["working", "working", "failed", "idle", "idle", "idle"];
  await withHosts(page, data => {
    const [first, ...rest] = data.hosts;
    const threads: Thread[] = statuses.map((status, index) => ({ id: `t-${index}`, name: `thread ${index}`, status, model: null, updatedAt: data.checkedAt - index * 1000, children: 0 }));
    threads.push({ id: "t-walk-1", name: "walk 1", status: "working", model: null, updatedAt: data.checkedAt, children: 0, test: true });
    threads.push({ id: "t-walk-2", name: "walk 2", status: "idle", model: null, updatedAt: data.checkedAt, children: 0, test: true });
    return { ...data, hosts: [{ ...first!, self: true, piHost: { state: "answering", version: "0.1.0" }, threads }, ...rest.map(host => ({ ...host, self: false }))] };
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

test("a box's actions menu refreshes it and copies its address", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/settings/hosts");
  const detail = page.locator('[data-testid^="host-"][aria-label]').first();
  await detail.getByRole("button", { name: "Host actions" }).click();
  const menu = page.getByRole("menu", { name: "Host actions" });
  await expect(menu.getByRole("menuitem", { name: /Refresh/ })).toBeVisible();
  const reread = page.waitForRequest(request => request.url().endsWith("/api/hosts"));
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
  await page.waitForRequest(request => request.url().endsWith("/api/hosts"));
  const started = Date.now();
  await page.waitForRequest(request => request.url().endsWith("/api/hosts"));
  expect(Date.now() - started).toBeLessThan(3500);
});

test("a box that does not answer says so, never zeros, a down pi-host is named, and the raw error stays in the tooltip", async ({ page }) => {
  await withHosts(page, data => {
    const [first, ...rest] = data.hosts;
    const away: Host = { name: "far-box", address: "100.64.0.9", self: false, relay: { state: "unreachable", error: "connect ETIMEDOUT" }, piHost: { state: "absent" }, machine: null, threads: [] };
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
  await page.route("**/api/hosts", route => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "hosts.json unreadable" }) }) : route.continue()));
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
      agentRelay: { state: "up", since: now - 600_000, lastPongAt: now - 4_000, version: "0.1.0", piHost: { up: true, version: "0.1.0" }, feedCursor: 7 }, machine: null, threads: [],
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

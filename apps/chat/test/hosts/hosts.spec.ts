import { expect, test } from "@playwright/test";

type Host = {
  name: string; address: string; self: boolean;
  relay: { state: "up"; pingMs: number } | { state: "unreachable"; error: string };
  piHost: { state: "answering"; version: string; socket: string } | { state: "down"; error: string } | { state: "absent" };
  machine: { cpu: { percent: number }; memory: { usedBytes: number; totalBytes: number } } | null;
  threads: { id: string; name: string; status: string }[];
};
type Report = { checkedAt: number; registryError: string | null; hosts: Host[] };

test("every box shows with its machine, services and threads, and a thread opens its channel", async ({ page }) => {
  await page.goto("/#/hosts");
  await expect(page.getByTestId("hosts-summary")).toBeVisible();
  const data = (await (await page.request.get("/api/hosts")).json()) as Report;
  const threads = data.hosts.reduce((sum, host) => sum + host.threads.length, 0);
  await expect(page.getByTestId("hosts-summary")).toContainText(`${data.hosts.length} host`);
  await expect(page.getByTestId("hosts-summary")).toContainText(`${threads} thread`);
  for (const host of data.hosts) {
    const card = page.getByTestId(`host-${host.name}`);
    await expect(card.getByRole("heading", { name: host.name, exact: true })).toBeVisible();
    if (host.self) await expect(card.getByText("This box", { exact: true }).first()).toBeVisible();
    if (host.machine) await expect(card.getByRole("meter", { name: "Memory" })).toBeVisible();
    await expect(card.getByText("pi-host", { exact: true })).toBeVisible();
    for (const thread of host.threads) await expect(card.getByTestId(`host-thread-${thread.id}`)).toContainText(thread.name);
  }
  const first = data.hosts.flatMap(host => host.threads)[0];
  test.skip(!first, "no threads on any pi-host");
  await page.getByTestId(`host-thread-${first!.id}`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${first!.id}$`));
});

test("the page reads the hosts again every 2 seconds", async ({ page }) => {
  await page.goto("/#/hosts");
  await page.waitForRequest(request => request.url().endsWith("/api/hosts"));
  const started = Date.now();
  await page.waitForRequest(request => request.url().endsWith("/api/hosts"));
  expect(Date.now() - started).toBeLessThan(3500);
});

test("a box that does not answer says so, never zeros, and a down pi-host is named", async ({ page }) => {
  await page.route("**/api/hosts", async route => {
    const response = await route.fetch();
    const data = (await response.json()) as Report;
    const [first, ...rest] = data.hosts;
    const away: Host = { name: "far-box", address: "100.64.0.9", self: false, relay: { state: "unreachable", error: "connect ETIMEDOUT" }, piHost: { state: "absent" }, machine: null, threads: [] };
    const down: Host = { ...first!, piHost: { state: "down", error: "socket refused" } };
    await route.fulfill({ response, json: { ...data, hosts: [down, ...rest, away] } });
  });
  await page.goto("/#/hosts");
  const far = page.getByTestId("host-far-box");
  await expect(far.getByText("Not answering", { exact: true })).toBeVisible();
  await expect(far.getByText("connect ETIMEDOUT").first()).toBeVisible();
  await expect(far.getByRole("meter")).toHaveCount(0);
  await expect(page.getByTestId("hosts-summary")).toContainText("answering");
  await expect(page.getByText("pi-host down")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a failed hosts read shows the reason and Try again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/hosts", route => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "hosts.json unreadable" }) }) : route.continue()));
  await page.goto("/#/hosts");
  await expect(page.getByText("Hosts aren't available")).toBeVisible();
  await expect(page.getByText("hosts.json unreadable")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("hosts-summary")).toBeVisible();
});

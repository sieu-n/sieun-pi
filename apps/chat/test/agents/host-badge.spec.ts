import { expect, test, type Page } from "@playwright/test";

/**
 * Host badges (agent-model.md phase 6): an agent on another box than the chat's own shows that box beside its name on its card and in its
 * DM header, dimmed with "away" while the box is offline; a DM post that waits on an away box reads "Queued, Mac is offline"; and Create
 * agent offers the boxes of `GET /api/agent-hosts`. The fixture runs every agent on its own box, so the spec moves one agent to "mac" in
 * the server's answers.
 */

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

type Json = Record<string, unknown>;
type Agent = { id: string; name: string; room?: string; archived: boolean };

const MAC = { host: "mac", hostState: "away" };

/** Rewrites the server's answers so `agent` runs on the away Mac: the live hello and agent events, the agent list and its DM header. */
async function onMac(page: Page, agent: Agent): Promise<void> {
  const move = (summary: Json): Json => (summary.id === agent.id ? { ...summary, ...MAC } : summary);
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as Json;
      if (event.type === "hello") ws.send(JSON.stringify({ ...event, agents: (event.agents as Json[]).map(move) }));
      else if (event.type === "agent") ws.send(JSON.stringify({ ...event, agent: move(event.agent as Json) }));
      else ws.send(String(message));
    });
    ws.onMessage((message) => server.send(message));
  });
  await page.route(/\/api\/agents(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: ((await response.json()) as Json[]).map(move) });
  });
  await page.route(new RegExp(`/api/c/${agent.room}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const header = (await response.json()) as Json;
    await route.fulfill({ response, json: header.agent ? { ...header, agent: move(header.agent as Json) } : header });
  });
}

async function firstAgent(page: Page): Promise<Agent> {
  const response = await page.request.get("/api/agents");
  expect(response.ok()).toBeTruthy();
  const agent = ((await response.json()) as Agent[]).find((a) => !a.archived && a.room);
  test.skip(!agent, "no agent with a DM on this server");
  return agent!;
}

test("an agent on the away Mac shows a dimmed Mac badge on its card and in its DM header", async ({ page }) => {
  const agent = await firstAgent(page);
  await onMac(page, agent);
  await page.goto("/#/agents");
  const card = page.locator(`[role="gridcell"][data-agent-id="${agent.id}"]`);
  const badge = card.getByTestId("host-badge");
  await expect(badge).toHaveText("Mac · away", { timeout: 20_000 });
  await expect(badge).toHaveAttribute("data-away", "true");
  expect(await badge.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
  // Agents on the chat's own box show no badge.
  await expect(page.locator(`[role="gridcell"]:not([data-agent-id="${agent.id}"]) [data-testid="host-badge"]`)).toHaveCount(0);

  await expect(page.locator(`[data-root="agents"] a[href="#/agents/${encodeURIComponent(agent.id)}"]`).getByTestId("host-badge")).toHaveText("Mac · away");

  await page.goto(`/#/c/${agent.room}`);
  await expect(page.getByTestId("conversation-title")).toHaveText(agent.name, { timeout: 20_000 });
  await expect(page.locator(".panel-header").getByTestId("host-badge")).toHaveText("Mac · away");
  await expect(page.locator(`[data-sidebar-row][href$="/${agent.room}"]`).getByTestId("host-badge")).toHaveText("Mac · away");
});

test("a DM post that waits on an away box reads Queued, Mac is offline instead of Not delivered", async ({ page }) => {
  const agent = await firstAgent(page);
  await onMac(page, agent);
  await page.route(new RegExp(`/api/c/${agent.room}/items`), async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Json[] };
    const index = body.items.findLastIndex((item) => item.kind === "message" && (item.author as Json).id === "owner");
    if (index >= 0) {
      const item = body.items[index]!;
      const error = "queued, mac is offline";
      body.items[index] = { ...item, send: "failed", sendError: error, deliveries: [{ target: agent.id, name: agent.name, state: "queued", at: item.at, error }] };
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/#/c/${agent.room}`);
  const queued = page.locator('[data-send-state="queued"]');
  await expect(queued).toHaveText("Queued, Mac is offline", { timeout: 20_000 });
  await expect(page.locator('[data-send-state="failed"]')).toHaveCount(0);
  await expect(page.getByText(`${agent.name} was mentioned`)).toHaveCount(0);
});

test("Create agent offers each box, the chat's own first, an away box marked, and sends the picked host", async ({ page }) => {
  const me = (await (await page.request.get("/api/me")).json()) as { host: string };
  const hosts = [
    { box: "mac", label: "Mac", self: false, state: "up", home: "/Users/sieun", projects: ["/Users/sieun/src/sieun-pi"] },
    { box: "us-metal03", label: "us-metal03", self: false, state: "away" },
    { box: me.host, label: me.host, self: true, state: "up" },
  ];
  await page.route("**/api/agent-hosts", (route) => route.fulfill({ json: { hosts } }));
  let posted: Json | null = null;
  await page.route(/\/api\/agents$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted = route.request().postDataJSON() as Json;
    return route.fulfill({ status: 503, json: { error: "spec stops here" } });
  });
  await page.goto("/#/agents");
  await page.getByRole("button", { name: "New agent" }).first().click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  const host = dialog.getByLabel("Host", { exact: true });
  await expect(host).toHaveValue(me.host);
  expect(await host.locator("option").allTextContents()).toEqual([`${me.host} (this box)`, "Mac", "us-metal03 · away"]);
  await expect(host.locator('option[value="us-metal03"]')).toHaveAttribute("disabled", "");

  await host.selectOption("mac");
  await expect(dialog.getByLabel("Project folder", { exact: true })).toHaveValue("/Users/sieun/src/sieun-pi");
  await dialog.getByRole("textbox", { name: "Name" }).fill("mac scout");
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("spec stops here");
  expect(posted).toMatchObject({ name: "mac scout", host: "mac", cwd: "/Users/sieun/src/sieun-pi" });
});

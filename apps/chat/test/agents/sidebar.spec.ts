import { expect, test, type Page } from "@playwright/test";
import { agentPage, agentsSidebar, grid, listAgents, listJobs, sidebarRow, type Agent } from "./helpers.ts";

/** The Agents root's own sidebar: All agents, then live agents grouped by state, each row opening the agent's page as the main view. */

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

type Json = Record<string, unknown>;
const section = (page: Page, id: string) => agentsSidebar(page).locator(`[data-section="${id}"]`);

/** Proxies /api/live and gives the named agents the statuses the test needs, as the server's hello and agent events would. */
async function withStatuses(page: Page, statuses: Record<string, Agent["status"]>): Promise<void> {
  const apply = (agent: Json): Json => (statuses[agent.id as string] ? { ...agent, status: statuses[agent.id as string] } : agent);
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as Json;
      if (event.type === "hello") ws.send(JSON.stringify({ ...event, agents: (event.agents as Json[]).map(apply) }));
      else if (event.type === "agent") ws.send(JSON.stringify({ ...event, agent: apply(event.agent as Json) }));
      else ws.send(String(message));
    });
    ws.onMessage((message) => server.send(message));
  });
}

async function openSidebar(page: Page, hash = "#/agents") {
  await page.goto(`/${hash}`);
  await expect(agentsSidebar(page).getByRole("link", { name: "All agents" })).toBeVisible({ timeout: 20_000 });
}

test("the sidebar groups live agents into Working, Failed and Idle, with All agents on top", async ({ page, request }) => {
  const agents = await listAgents(request);
  test.skip(agents.length < 4, "needs four agents");
  const [working, waiting, failed, ...rest] = agents as [Agent, Agent, Agent, ...Agent[]];
  await withStatuses(page, { [working.id]: "working", [waiting.id]: "sleeping", [failed.id]: "failed", ...Object.fromEntries(rest.map((a) => [a.id, "idle"])) });
  await openSidebar(page);
  await expect(agentsSidebar(page).locator("h1")).toHaveText("Agents");
  await expect(agentsSidebar(page).getByRole("link", { name: "All agents" })).toHaveAttribute("aria-current", "page");
  await expect(agentsSidebar(page).locator("[data-section]")).toHaveCount(3);
  expect(await agentsSidebar(page).locator("[data-section]").evaluateAll((els) => els.map((el) => el.getAttribute("data-section")))).toEqual(["working", "failed", "idle"]);

  const names = (list: Agent[]) => list.map((a) => a.name).sort((a, b) => a.localeCompare(b));
  await expect(section(page, "working").locator("[data-sidebar-row] .label")).toHaveText(names([working, waiting]));
  await expect(section(page, "failed").locator("[data-sidebar-row] .label")).toHaveText(names([failed]));
  // Other specs create agents on the shared fixture server meanwhile, so Idle may hold more than this list.
  for (const agent of rest) await expect(section(page, "idle").locator(`a[href="#/agents/${agent.id}"]`)).toHaveCount(1);
  await expect(sidebarRow(page, working)).toHaveAttribute("data-working", "true");
  await expect(sidebarRow(page, waiting)).not.toHaveAttribute("data-working", "true");
  await expect(section(page, "working").locator(".count")).toHaveText("2");
});

test("Failed shows only while an agent failed", async ({ page, request }) => {
  const agents = await listAgents(request);
  test.skip(!agents.length, "no agents on this server");
  await withStatuses(page, Object.fromEntries(agents.map((a) => [a.id, "idle"])));
  await openSidebar(page);
  await expect(section(page, "failed")).toHaveCount(0);
  await expect(section(page, "working")).toContainText("Nobody is working.");
  for (const agent of agents) await expect(section(page, "idle").locator(`a[href="#/agents/${agent.id}"]`)).toHaveCount(1);
});

test("a row opens the agent's page as the main view and stays selected, also while one of its jobs is open", async ({ page, request }) => {
  const [agents, jobs] = await Promise.all([listAgents(request), listJobs(request)]);
  test.skip(!agents.length, "no agents on this server");
  const agent = agents.find((a) => jobs.some((job) => job.agent?.id === a.id)) ?? agents[0]!;
  await openSidebar(page);
  await sidebarRow(page, agent).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}$`));
  await expect(agentPage(page)).toHaveAttribute("data-agent-id", agent.id);
  await expect(grid(page)).toHaveCount(0);
  await expect(sidebarRow(page, agent)).toHaveAttribute("aria-current", "page");
  await expect(agentsSidebar(page).getByRole("link", { name: "All agents" })).not.toHaveAttribute("aria-current", "page");

  const job = jobs.find((entry) => entry.agent?.id === agent.id);
  if (job) {
    await page.goto(`/#/agents/${encodeURIComponent(job.id)}`);
    await expect(agentPage(page)).toHaveAttribute("data-agent-id", job.id, { timeout: 20_000 });
    await expect(sidebarRow(page, agent)).toHaveAttribute("aria-current", "page");
  }

  await agentsSidebar(page).getByRole("link", { name: "All agents" }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(grid(page)).toBeVisible();
  await expect(agentPage(page)).toHaveCount(0);
});

test("a deep link with an old section opens the page on its new tab with its row selected", async ({ page, request }) => {
  const agent = (await listAgents(request)).find((a) => a.kind === "chat");
  test.skip(!agent, "no agents on this server");
  await openSidebar(page, `#/agents/${agent!.id}?section=swarm`);
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent!.id}\\?section=jobs$`));
  await expect(agentPage(page).getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");
  await expect(sidebarRow(page, agent!)).toHaveAttribute("aria-current", "page");
});

test("a folded group hides its rows but keeps the open agent, and stays folded after a reload", async ({ page, request }) => {
  const agents = await listAgents(request);
  test.skip(agents.length < 2, "needs two agents");
  await withStatuses(page, Object.fromEntries(agents.map((a) => [a.id, "idle"])));
  const open = agents[0]!;
  await openSidebar(page, `#/agents/${open.id}`);
  const idle = section(page, "idle");
  await idle.getByRole("button", { name: /^Idle/ }).click();
  await expect(idle.getByRole("button", { name: /^Idle/ })).toHaveAttribute("aria-expanded", "false");
  await expect(idle.locator("[data-sidebar-row] .label")).toHaveText([open.name]);
  await page.reload();
  await expect(section(page, "idle").locator("[data-sidebar-row] .label")).toHaveText([open.name], { timeout: 20_000 });
  await section(page, "idle").getByRole("button", { name: /^Idle/ }).click();
  for (const agent of agents) await expect(section(page, "idle").locator(`a[href="#/agents/${agent.id}"]`)).toHaveCount(1);
});

test("the sidebar's New agent opens the one Create agent dialog", async ({ page, request }) => {
  const agent = (await listAgents(request))[0];
  test.skip(!agent, "no agents on this server");
  await openSidebar(page, `#/agents/${agent!.id}`);
  await agentsSidebar(page).getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent!.id}$`));
});

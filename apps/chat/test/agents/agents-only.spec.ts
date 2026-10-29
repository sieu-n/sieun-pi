import { expect, test, type Locator, type Page } from "@playwright/test";
import { composerInput, conversation, open } from "../channel/helpers.ts";
import { card, grid, listAgents, listJobs, openAgents, roomOf, type Agent } from "./helpers.ts";

/**
 * The owner's model (apps/chat/docs/agent-model.md): an agent is a registered template such as Vent, and its threads and jobs are its
 * internal work. Every picker lists registered agents only, and a job shows only inside its agent's card.
 */

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

const picker = (page: Page, label: string) => page.getByRole("dialog", { name: label });
const labels = (scope: Locator) => scope.getByRole("option").locator(".label").allTextContents();

/** Each row names a registered agent, and no row says what a job works for. */
async function expectOnlyAgents(scope: Locator, agents: readonly Agent[]) {
  await expect(scope.getByRole("option").first()).toBeVisible();
  const names = new Set(agents.map((agent) => agent.name));
  expect((await labels(scope)).filter((label) => !names.has(label))).toEqual([]);
  await expect(scope).not.toContainText(/job of/i);
}

let agents: Agent[] = [];
let jobs: Agent[] = [];
test.beforeEach(async ({ request }) => {
  [agents, jobs] = await Promise.all([listAgents(request), listJobs(request)]);
  test.skip(!agents.length, "no agents on this server");
});

test("the server lists registered agents apart from the jobs that work for them", async ({ request }) => {
  for (const agent of agents) expect(agent.id).toMatch(/^ag_/);
  for (const job of jobs) {
    expect(job.kind).toBe("job");
    expect(agents.map((agent) => agent.id)).toContain(job.agent?.id);
  }
  const directory = (await (await request.get("/api/directory")).json()) as { agents: Agent[]; jobs: Agent[] };
  expect(directory.agents.every((agent) => agent.id.startsWith("ag_"))).toBe(true);
  expect(directory.jobs.every((job) => job.kind === "job" && !!job.agent)).toBe(true);
});

test("the composer's @ picker lists registered agents only", async ({ page }) => {
  await open(page, `#/c/${roomOf(agents[0]!.id)}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type("@");
  const list = picker(page, "Agents");
  await expectOnlyAgents(list, agents);
  await expect(list.getByRole("option")).toHaveCount(Math.min(agents.length, 8));
  await expect(list.locator(".trailing").first()).toHaveText("agent");
  for (const job of jobs.slice(0, 5)) {
    if (agents.some((agent) => agent.name === job.name)) continue;
    await page.keyboard.press("Escape");
    await composerInput(conversation(page)).fill("");
    await page.keyboard.type(`@${job.name.slice(0, 12)}`);
    await expect(page.getByRole("option", { name: new RegExp(`^${job.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toHaveCount(0);
  }
});

test("New message picks among registered agents only", async ({ page }) => {
  await open(page, "#/c/new?kind=dm", "main-panel");
  const list = picker(page, "Message");
  await expectOnlyAgents(list, agents);
  expect((await labels(list)).sort()).toEqual(agents.map((agent) => agent.name).sort());
});

test("a new channel's member picker lists registered agents only", async ({ page }) => {
  await open(page, "#/c/new?kind=channel", "main-panel");
  await page.getByRole("button", { name: "Add agents" }).click();
  const list = picker(page, "Add members");
  await expectOnlyAgents(list, agents);
  expect((await labels(list)).sort()).toEqual(agents.map((agent) => agent.name).sort());
});

test("the Agents page shows agent cards only, and a job shows inside its agent's card and Swarm", async ({ page, request }) => {
  await openAgents(page);
  await expect(grid(page).getByRole("gridcell")).toHaveCount(agents.length);
  for (const agent of agents) await expect(card(page, agent)).toBeVisible();
  for (const job of jobs) await expect(card(page, job)).toHaveCount(0);
  await expect(page.getByText("Other jobs")).toHaveCount(0);

  const busiest = agents
    .map((agent) => ({ agent, count: jobs.filter((job) => job.agent?.id === agent.id).length }))
    .sort((a, b) => b.count - a.count)[0]!;
  test.skip(!busiest.count, "no agent has jobs on this server");
  await expect(card(page, busiest.agent).locator("[data-jobs]")).toContainText(`${busiest.count} ${busiest.count === 1 ? "job" : "jobs"}`);

  const config = (await (await request.get(`/api/agents/${encodeURIComponent(busiest.agent.id)}/config`)).json()) as { swarm: { jobs: { id: string }[] } };
  await page.goto(`/#/agents/${encodeURIComponent(busiest.agent.id)}?section=swarm`);
  const swarm = page.getByTestId("agent-config").getByRole("tabpanel");
  await expect(swarm.locator("li[data-job-id]")).toHaveCount(config.swarm.jobs.length);
  expect(config.swarm.jobs.length).toBeGreaterThan(0);
});

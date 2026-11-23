import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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

/**
 * The rows are the server's registered agents, the first `shown` of them, and no row says what a job works for. Other specs add and
 * archive agents on the same fixture server while this one runs, so each try reads the server's list again. toPass keeps trying until
 * the test's own timeout, because at load 726 one try took 7.8 s (a 1 s GET and a 6.4 s read of the rows).
 */
async function expectOnlyAgents(scope: Locator, request: APIRequestContext, shown = Infinity) {
  await expect(scope.getByRole("option").first()).toBeVisible();
  await expect(async () => {
    const names = (await listAgents(request)).map((agent) => agent.name);
    const rows = await labels(scope);
    expect(rows.filter((label) => !names.includes(label))).toEqual([]);
    expect(rows).toHaveLength(Math.min(names.length, shown));
  }).toPass();
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

test("the composer's @ picker lists registered agents only", async ({ page, request }) => {
  await open(page, `#/c/${roomOf(agents[0]!.id)}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type("@");
  const list = picker(page, "Agents");
  await expectOnlyAgents(list, request, 8);
  await expect(list.locator(".trailing").first()).toHaveText("agent");
  for (const job of jobs.slice(0, 5)) {
    if (agents.some((agent) => agent.name === job.name)) continue;
    await page.keyboard.press("Escape");
    await composerInput(conversation(page)).fill("");
    await page.keyboard.type(`@${job.name.slice(0, 12)}`);
    await expect(page.getByRole("option", { name: new RegExp(`^${job.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toHaveCount(0);
  }
});

test("New message picks among registered agents only", async ({ page, request }) => {
  await open(page, "#/c/new?kind=dm", "main-panel");
  await expectOnlyAgents(picker(page, "Agents"), request);
});

test("a new channel's member picker lists registered agents only", async ({ page, request }) => {
  await open(page, "#/c/new?kind=channel", "main-panel");
  await page.getByRole("button", { name: "Add agents" }).click();
  await expectOnlyAgents(picker(page, "Add members"), request);
});

test("the Agents page shows agent cards only, and a job shows inside its agent's card and Jobs tab", async ({ page, request }) => {
  await openAgents(page);
  // Other specs add and archive agents, and the fixture files a check-in job under Vent about 30 s after it starts and archives it about
  // 30 s later (notes in ~/work/chat-specs-red/specs-red-agents-agents-only), so each try reads the server's lists again.
  await expect(async () => {
    const [live, working] = await Promise.all([listAgents(request), listJobs(request)]);
    const ids = await grid(page).getByRole("gridcell").evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-agent-id")));
    expect(ids.sort()).toEqual(live.map((agent) => agent.id).sort());
    expect(ids.filter((id) => working.some((job) => job.id === id))).toEqual([]);
  }).toPass();
  await expect(page.getByText("Other jobs")).toHaveCount(0);

  const busiest = agents
    .map((agent) => ({ agent, count: jobs.filter((job) => job.agent?.id === agent.id).length }))
    .sort((a, b) => b.count - a.count)[0]!;
  test.skip(!busiest.count, "no agent has jobs on this server");
  await expect(async () => {
    const count = (await listJobs(request)).filter((job) => job.agent?.id === busiest.agent.id).length;
    expect(await card(page, busiest.agent).locator("[data-jobs]").textContent()).toContain(`${count} ${count === 1 ? "job" : "jobs"}`);
  }).toPass();

  const swarm = page.getByTestId("agent-config").getByRole("tabpanel");
  await expect(async () => {
    const config = (await (await request.get(`/api/agents/${encodeURIComponent(busiest.agent.id)}/config`)).json()) as { swarm: { jobs: { id: string }[] } };
    expect(config.swarm.jobs.length).toBeGreaterThan(0);
    let listed = 0;
    for (const filter of ["active", "finished", "archived"]) {
      await page.goto(`/#/agents/${encodeURIComponent(busiest.agent.id)}?section=threads&jobs=${filter}`);
      await expect(swarm.getByTestId("agent-jobs")).toHaveAttribute("data-filter", filter);
      if (await swarm.getByTestId("jobs-show-all").count()) await swarm.getByTestId("jobs-show-all").click();
      listed += await swarm.locator("li[data-job-id]").count();
    }
    expect(listed).toBe(config.swarm.jobs.length);
  }).toPass();
});

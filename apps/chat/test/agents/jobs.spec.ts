import { expect, test, type Page } from "@playwright/test";
import { agentPage } from "./helpers.ts";

/**
 * An agent's Jobs tab: Active, Finished and Archived filters, a name search kept in the URL, and Archive on a finished job's row with an
 * Undo in its toast. It runs on the fixture's AI harness VP, whose thread holds jobs inside it, and puts each job it archives back.
 */
test.describe.configure({ retries: 1 });

type Job = { id: string; name: string; status: string; archived: boolean };
const AGENT = "ag_ai-harness-developer-environment-vp";
const jobsTab = (page: Page) => agentPage(page).getByTestId("agent-jobs");
const row = (page: Page, job: Pick<Job, "id">) => jobsTab(page).locator(`li[data-job-id="${job.id}"]`);

test("the Jobs tab filters by state, searches by name, and archives a finished job with Undo", async ({ page, request }) => {
  const config = (await (await request.get(`/api/agents/${AGENT}/config`)).json()) as { swarm: { jobs: Job[] } };
  const live = config.swarm.jobs.filter((job) => !job.archived);
  const active = live.filter((job) => job.status === "working" || job.status === "sleeping");
  const finished = live.filter((job) => job.status === "idle" || job.status === "failed");
  test.skip(!active.length || !finished.length, "the fixture agent needs a running and a finished job");

  await page.goto(`/#/agents/${AGENT}?section=jobs`);
  await expect(jobsTab(page)).toHaveAttribute("data-filter", "active");
  await expect(jobsTab(page).locator("li[data-job-id]")).toHaveCount(active.length);
  await expect(jobsTab(page).getByRole("tab", { name: /Finished/ })).toContainText(String(finished.length));

  await jobsTab(page).getByRole("tab", { name: /Finished/ }).click();
  await expect(page).toHaveURL(/jobs=finished/);
  await expect(jobsTab(page).locator("li[data-job-id]")).toHaveCount(finished.length);

  const job = finished[0]!;
  const word = job.name.split(/\s+/).find((w) => w.length > 3) ?? job.name;
  await jobsTab(page).getByRole("searchbox", { name: "Search jobs" }).fill(word);
  await expect(page).toHaveURL(/jobq=/);
  await expect(row(page, job)).toBeVisible();
  const hits = finished.filter((j) => j.name.toLowerCase().includes(word.toLowerCase()));
  await expect(jobsTab(page).locator("li[data-job-id]")).toHaveCount(hits.length);

  await row(page, job).hover();
  await row(page, job).getByRole("button", { name: `Archive ${job.name}` }).click();
  await expect(row(page, job)).toHaveCount(0);
  await expect(page.getByText(`Archived ${job.name}`)).toBeVisible();
  await jobsTab(page).getByRole("tab", { name: /Archived/ }).click();
  await expect(row(page, job)).toBeVisible();
  await expect(row(page, job)).toHaveAttribute("data-archived", "true");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, job)).toHaveCount(0);
  await jobsTab(page).getByRole("tab", { name: /Finished/ }).click();
  await expect(row(page, job)).toBeVisible();

  await row(page, job).hover();
  await row(page, job).getByRole("button", { name: `Actions for ${job.name}` }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open job", "Open conversation", "Archive"]);
  await page.keyboard.press("Escape");

  await jobsTab(page).getByRole("searchbox", { name: "Search jobs" }).fill("zz no job has this name");
  await expect(jobsTab(page).getByText(/No finished job matches/)).toBeVisible();
  await jobsTab(page).getByRole("button", { name: "Clear search" }).click();
  await expect(jobsTab(page).locator("li[data-job-id]")).toHaveCount(finished.length);

  const after = (await (await request.get(`/api/agents/${AGENT}/config`)).json()) as { swarm: { jobs: Job[] } };
  expect(after.swarm.jobs.find((j) => j.id === job.id)?.archived).toBe(false);
});

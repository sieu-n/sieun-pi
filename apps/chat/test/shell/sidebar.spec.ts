import { expect, test, type Page } from "@playwright/test";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const filter = (page: Page, name: string) => sidebar(page).getByRole("tab", { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
});

test("All shows Solo and Team, Solo hides Team, Team hides Solo", async ({ page }) => {
  const solo = sidebar(page).locator('[data-section="solo"]');
  const team = sidebar(page).locator('[data-section="team"]');
  await expect(solo).toBeVisible();
  await expect(team).toBeVisible();

  await filter(page, "Solo").click();
  await expect(solo).toBeVisible();
  await expect(team).toHaveCount(0);

  await filter(page, "Team").click();
  await expect(team).toBeVisible();
  await expect(solo).toHaveCount(0);
  await expect(team.getByRole("heading", { name: "Team" })).toHaveCount(0);
});

test("the filter choice survives a reload", async ({ page }) => {
  await filter(page, "Team").click();
  await page.reload();
  await expect(filter(page, "Team")).toHaveAttribute("aria-selected", "true");
});

test("a row opens its conversation and turns lime", async ({ page }) => {
  const row = sidebar(page).getByRole("link", { name: "frontend bro" });
  await row.click();
  await expect(page).toHaveURL(/#\/c\/0f1e0000-0000-4000-8000-000000000004$/);
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(row).toHaveCSS("background-color", "rgb(190, 218, 54)");
});

test("opening a Solo chat while Team is on switches the filter to Solo", async ({ page }) => {
  await filter(page, "Team").click();
  await page.goto("/#/c/0f1e0000-0000-4000-8000-000000000001");
  await expect(filter(page, "Solo")).toHaveAttribute("aria-selected", "true");
});

test("unread rows are bold and working rows show typing dots", async ({ page }) => {
  const crawler = sidebar(page).getByRole("link", { name: "Crawler VP" });
  await expect(crawler).toHaveAttribute("data-unread", "true");
  await expect(crawler).toHaveCSS("font-weight", "500");
  await expect(sidebar(page).getByRole("link", { name: "Vent", exact: true })).toHaveCSS("font-weight", "400");
  const cutover = sidebar(page).getByRole("link", { name: "pi-cutover" });
  await expect(cutover).toHaveAttribute("data-working", "true");
  await expect(cutover.getByRole("status")).toHaveAttribute("aria-label", /working in pi-cutover/);
});

test("Direct messages list only agents: a duty run's thread, a root job and a job inside a thread stay out and still open by link", async ({ page, request }) => {
  const dms = sidebar(page).locator('[data-section="team"]');
  await expect(dms.getByRole("heading", { name: "Direct messages" })).toBeVisible();
  const all = (await (await request.get("/api/conversations")).json()) as { id: string; kind: string; name: string; archived: boolean }[];
  const listed = ((await (await request.get("/api/sidebar")).json()) as { dms: { id: string }[] }).dms.map((dm) => dm.id);
  const jobs = all.filter((c) => c.kind === "job" && !c.archived);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) expect(listed).not.toContain(job.id);
  for (const job of jobs.slice(0, 6)) await expect(sidebar(page).getByRole("link", { name: job.name, exact: true })).toHaveCount(0);
  for (const id of listed) await expect(sidebar(page).locator(`a[href="#/c/${id}"]`)).toBeVisible();
  const duty = jobs.find((job) => / duty \d{6}-\d{6}$/.test(job.name)) ?? jobs[0]!;
  await page.goto(`/#/c/${encodeURIComponent(duty.id)}`);
  await expect(page.getByTestId("main-panel")).toContainText(duty.name.slice(0, 20), { timeout: 20_000 });
  await expect(sidebar(page).getByRole("link", { name: duty.name, exact: true })).toHaveCount(0);
});

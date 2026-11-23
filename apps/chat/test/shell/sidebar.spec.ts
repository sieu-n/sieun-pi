import { expect, test, type Page } from "@playwright/test";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c/ch_general");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
});

test("one list holds For you, Solo, Channels and Direct messages, with no All, Solo or Team switcher", async ({ page }) => {
  await expect(sidebar(page).getByRole("tab")).toHaveCount(0);
  await expect(sidebar(page).getByRole("heading", { name: "Team" })).toHaveCount(0);
  await expect(sidebar(page).getByRole("link", { name: "For you" })).toBeVisible();
  for (const name of ["Solo", "Channels", "Direct messages"]) await expect(sidebar(page).getByRole("heading", { name, exact: true })).toBeVisible();
  // Solo holds Solo rooms only: the fixture's untitled root chat no agent holds is in no group.
  await expect(sidebar(page).locator('[data-section="solo"]')).toContainText("relay protocol");
  await expect(sidebar(page).getByRole("link", { name: "New thread" })).toHaveCount(0);
});

test("a row opens its agent's DM and takes the soft citrus fill", async ({ page }) => {
  const row = sidebar(page).getByRole("link", { name: "frontend bro" });
  await row.click();
  await expect(page).toHaveURL(/#\/c\/dm_frontend-bro$/);
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(row).toHaveCSS("background-color", "rgb(232, 240, 205)");
});

test("unread rows are bold and working rows show typing dots in a bubble", async ({ page }) => {
  // Other specs read, close and fold the seeded rooms, so the unread and the read row are this test's own channels.
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const room = async (name: string): Promise<{ id: string; post: string }> => {
    const id = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
    made.push(id);
    const sent = await page.request.post(`/api/c/${id}/send`, { data: { text: `first post of ${name}`, requestId: crypto.randomUUID() } });
    return { id, post: ((await sent.json()) as { item: { id: string } }).item.id };
  };
  const unread = await room(`sidebar-unread-${tag}`);
  const read = await room(`sidebar-read-${tag}`);
  try {
    expect((await page.request.post(`/api/c/${unread.id}/read`, { data: { unreadFrom: unread.post } })).ok()).toBe(true);
    // A folded section still shows the open room and the unread ones, so open the read one to keep it on screen.
    await page.goto(`/#/c/${read.id}`);
    const unreadRow = sidebar(page).locator(`a[href="#/c/${unread.id}"]`);
    await expect(unreadRow).toHaveAttribute("data-unread", "true", { timeout: 15_000 });
    await expect(unreadRow).toHaveCSS("font-weight", "500");
    const readRow = sidebar(page).locator(`a[href="#/c/${read.id}"]`);
    await expect(readRow).toHaveAttribute("aria-current", "page");
    await expect(readRow).not.toHaveAttribute("data-unread");
    await expect(readRow).toHaveCSS("font-weight", "400");
  } finally {
    await page.request.delete(`/api/later/${encodeURIComponent(`${unread.id}:${unread.post}`)}`);
    for (const id of made) await page.request.patch(`/api/rooms/${id}`, { data: { archived: true } });
  }
  const cutover = sidebar(page).getByRole("link", { name: "pi-cutover" });
  await expect(cutover).toHaveAttribute("data-working", "true");
  await expect(cutover.getByRole("status")).toHaveAttribute("aria-label", /working in pi-cutover/);
  await expect(cutover.getByRole("status").locator("..")).toHaveCSS("background-color", "rgb(232, 240, 205)");
});

test("Direct messages list only agents: a duty run's thread, a root job and a job inside a thread stay out and still open by link", async ({ page, request }) => {
  const dms = sidebar(page).locator('[data-section="dms"]');
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

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
  // Another spec folds Direct messages on the server's layout for a while, and a folded section keeps only the open and the unread rows, so
  // the row is this test's own agent's DM with an unread answer.
  const name = `sidebar row ${Date.now().toString(36)}`;
  const agent = (await (await page.request.post("/api/agents", { data: { name } })).json()) as { id: string };
  const dm = `dm_${agent.id.slice(3)}`;
  try {
    await page.request.post(`/api/c/${dm}/send`, { data: { text: "check the relay", requestId: crypto.randomUUID() } });
    const row = sidebar(page).getByRole("link", { name });
    await expect(row).toHaveAttribute("data-unread", "true", { timeout: 15_000 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/c/${dm}$`));
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(row).toHaveCSS("background-color", "rgb(232, 240, 205)");
  } finally {
    await page.request.patch(`/api/c/${dm}`, { data: { archived: true } });
  }
});

test("unread rows are bold and working rows show typing dots in a bubble", async ({ page }) => {
  // Other specs read, close, fold and post in the seeded rooms, and any post in #pi-cutover ends its seeded working turn, so every row here is
  // this test's own channel.
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const room = async (name: string, members: string[] = [], text = `first post of ${name}`): Promise<{ id: string; post: string }> => {
    const id = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members } })).json()) as { id: string }).id;
    made.push(id);
    const sent = await page.request.post(`/api/c/${id}/send`, { data: { text, requestId: crypto.randomUUID() } });
    return { id, post: ((await sent.json()) as { item: { id: string } }).item.id };
  };
  const unread = await room(`sidebar-unread-${tag}`);
  const read = await room(`sidebar-read-${tag}`);
  // The fixture's member answers a post that says "slow" one word a second, about 60 s, so the row stays working through the checks.
  const workingName = `sidebar-working-${tag}`;
  const working = await room(workingName, ["ag_crawler-vp"], "slow: check the relay");
  try {
    // Another spec folds Channels on the server's layout for a while, and a folded section keeps only the open and the unread rows, so the
    // working row is unread too.
    for (const marked of [unread, working]) expect((await page.request.post(`/api/c/${marked.id}/read`, { data: { unreadFrom: marked.post } })).ok()).toBe(true);
    // A folded section still shows the open room and the unread ones, so open the read one to keep it on screen.
    await page.goto(`/#/c/${read.id}`);
    const unreadRow = sidebar(page).locator(`a[href="#/c/${unread.id}"]`);
    await expect(unreadRow).toHaveAttribute("data-unread", "true", { timeout: 15_000 });
    await expect(unreadRow).toHaveCSS("font-weight", "500");
    const readRow = sidebar(page).locator(`a[href="#/c/${read.id}"]`);
    await expect(readRow).toHaveAttribute("aria-current", "page");
    await expect(readRow).not.toHaveAttribute("data-unread");
    await expect(readRow).toHaveCSS("font-weight", "400");
    const workingRow = sidebar(page).locator(`a[href="#/c/${working.id}"]`);
    await expect(workingRow).toHaveAttribute("data-working", "true");
    await expect(workingRow.getByRole("status")).toHaveAttribute("aria-label", `Crawler VP working in ${workingName}`);
    await expect(workingRow.getByRole("status").locator("..")).toHaveCSS("background-color", "rgb(232, 240, 205)");
  } finally {
    for (const marked of [unread, working]) await page.request.delete(`/api/later/${encodeURIComponent(`${marked.id}:${marked.post}`)}`);
    for (const id of made) await page.request.patch(`/api/rooms/${id}`, { data: { archived: true } });
  }
});

test("Direct messages list only agents: a duty run's thread, a root job and a job inside a thread stay out and still open by link", async ({ page, request }) => {
  // The open DM keeps its row while another spec folds Direct messages on the server's layout, as a folded section keeps the open row.
  await page.goto("/#/c/dm_frontend-bro");
  const dms = sidebar(page).locator('[data-section="dms"]');
  await expect(dms.getByRole("heading", { name: "Direct messages" })).toBeVisible();
  const all = (await (await request.get("/api/conversations")).json()) as { id: string; kind: string; name: string; archived: boolean }[];
  const listedDms = async () => ((await (await request.get("/api/sidebar")).json()) as { dms: { id: string }[] }).dms.map((dm) => dm.id);
  const listed = await listedDms();
  const jobs = all.filter((c) => c.kind === "job" && !c.archived);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) expect(listed).not.toContain(job.id);
  for (const job of jobs.slice(0, 6)) await expect(sidebar(page).getByRole("link", { name: job.name, exact: true })).toHaveCount(0);
  // Every listed DM has a row while no section is folded; under a fold the open one still does. Other specs add agents meanwhile, so each
  // look reads the list again.
  await expect.poll(async () => {
    const now = await listedDms();
    const view = await sidebar(page).evaluate((nav) => ({
      folded: [...nav.querySelectorAll('[data-fold][aria-expanded="false"]')].some((fold) => fold.getAttribute("data-fold") !== "done"),
      shown: [...nav.querySelectorAll("a[data-sidebar-row]")].map((row) => row.getAttribute("href")),
    }));
    return (view.folded ? ["dm_frontend-bro"] : now).filter((id) => !view.shown.includes(`#/c/${id}`));
  }).toEqual([]);
  const duty = jobs.find((job) => / duty \d{6}-\d{6}$/.test(job.name)) ?? jobs[0]!;
  await page.goto(`/#/c/${encodeURIComponent(duty.id)}`);
  await expect(page.getByTestId("main-panel")).toContainText(duty.name.slice(0, 20), { timeout: 20_000 });
  await expect(sidebar(page).getByRole("link", { name: duty.name, exact: true })).toHaveCount(0);
});

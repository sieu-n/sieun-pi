import { expect, test } from "@playwright/test";
import { card, grid, listAgents, listJobs, openAgents, roomOf } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

test("Your agents shows one card per registered agent with its name, model and status", async ({ page, request }) => {
  const chats = await listAgents(request);
  await openAgents(page);
  if (!chats.length) {
    await expect(page.getByRole("button", { name: "Create your first agent" })).toBeVisible();
    return;
  }
  await expect(grid(page).getByRole("gridcell")).toHaveCount(chats.length);
  for (const chat of chats) {
    const cell = card(page, chat);
    await expect(cell).toContainText(chat.name);
    if (chat.model) await expect(cell).toContainText(chat.model.label);
    const word = { working: "Working", sleeping: "Waiting", failed: "Failed", idle: "Idle" }[chat.status];
    await expect(cell).toContainText(word);
  }
});

test("a job has no card of its own and counts on the card of the agent it works for", async ({ page, request }) => {
  const [agents, jobs] = await Promise.all([listAgents(request), listJobs(request)]);
  test.skip(!agents.length, "no agents on this server");
  await openAgents(page);
  await expect(grid(page).getByRole("gridcell")).toHaveCount(agents.length);
  await expect(page.getByRole("tab", { name: /Jobs/ })).toHaveCount(0);
  for (const job of jobs) await expect(card(page, job)).toHaveCount(0);
  for (const agent of agents) {
    const total = jobs.filter((job) => job.agent?.id === agent.id).length;
    if (total) await expect(card(page, agent).locator("[data-jobs]")).toContainText(`${total} ${total === 1 ? "job" : "jobs"}`);
    else await expect(card(page, agent).locator("[data-jobs]")).toHaveCount(0);
  }
});

test("the grid has Buzz's measures: a 768 px column, 192 px tracks, 244 px cards with a 24 px radius", async ({ page, request }) => {
  const chats = await listAgents(request);
  test.skip(!chats.length, "no agents on this server");
  await openAgents(page);
  const first = card(page, chats[0]!);
  const box = (await first.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(244);
  expect(box.width).toBeGreaterThanOrEqual(192);
  expect(await first.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("24px");
  const toolbar = (await page.getByRole("heading", { name: "Your agents" }).boundingBox())!;
  const button = (await page.getByRole("button", { name: "New agent" }).boundingBox())!;
  expect(Math.round(button.x + button.width - toolbar.x)).toBe(720);
});

test("a card opens its configuration, and Message opens an agent's DM or a job's pane beside its agent's DM", async ({ page, request }) => {
  const [agents, jobs] = await Promise.all([listAgents(request), listJobs(request)]);
  const chat = agents[0];
  test.skip(!chat, "no agents on this server");
  await openAgents(page);
  await card(page, chat!).click({ position: { x: 40, y: 120 } });
  await expect(page).toHaveURL(new RegExp(`#/agents/${chat!.id}$`));
  await expect(card(page, chat!)).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("agent-config").getByRole("button", { name: "Message" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${roomOf(chat!.id)}$`));
  const job = jobs.find((entry) => entry.agent);
  if (!job) return;
  await page.goto(`/#/agents/${encodeURIComponent(job.id)}`);
  await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 20_000 });
  await expect(card(page, job)).toHaveCount(0);
  await page.getByTestId("agent-config").getByRole("button", { name: "Message" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${roomOf(job.agent!.id)}\\?thread=${encodeURIComponent(job.id)}$`));
});

test("the ... button and a right click open the same menu, with Stop only while working", async ({ page, request }) => {
  const agents = await listAgents(request);
  test.skip(!agents.length, "no agents on this server");
  await openAgents(page);
  for (const agent of agents) {
    const cell = card(page, agent);
    await cell.getByRole("button", { name: `Actions for ${agent.name}` }).click();
    const menu = page.getByRole("menu");
    const expected = ["Message", "Change model", ...(agent.status === "working" || agent.status === "sleeping" ? ["Stop"] : []), "Archive"];
    await expect(menu.getByRole("menuitem")).toHaveText(expected);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  const first = card(page, agents[0]!);
  await first.click({ button: "right", position: { x: 40, y: 120 } });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Message" })).toBeVisible();
  await page.getByRole("menu").getByRole("menuitem", { name: "Message" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${roomOf(agents[0]!.id)}$`));
});

test("Stop sends the abort for that agent", async ({ page, request }) => {
  const agents = await listAgents(request);
  const target = agents[0];
  test.skip(!target, "no agents on this server");
  const working = { ...target!, status: "working" as const };
  await page.route("**/api/agents", (route) => route.fulfill({ json: agents.map((agent) => (agent.id === working.id ? working : agent)) }));
  await page.routeWebSocket(/\/api\/live/, () => {});
  let aborted = "";
  await page.route("**/api/c/*/abort", (route) => {
    aborted = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!);
    return route.fulfill({ json: { ok: true } });
  });
  await openAgents(page);
  await card(page, working).getByRole("button", { name: `Actions for ${working.name}` }).click();
  await page.getByRole("menuitem", { name: "Stop" }).click();
  await expect.poll(() => aborted).toBe(roomOf(working.id));
  await expect(page.getByText(`Stopped ${working.name}`)).toBeVisible();
});

test("arrow keys move between cards, Enter opens one's configuration and Esc closes it", async ({ page, request }) => {
  const chats = await listAgents(request);
  test.skip(chats.length < 2, "needs two agents");
  await openAgents(page);
  const cells = grid(page).getByRole("gridcell");
  await cells.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(cells.nth(1)).toBeFocused();
  const id = await cells.nth(1).getAttribute("data-agent-id");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/agents/${id}$`));
  await expect(page.getByTestId("agent-config")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(page.getByTestId("agent-config")).toHaveCount(0);
  await expect(cells.nth(1)).toBeFocused();
});

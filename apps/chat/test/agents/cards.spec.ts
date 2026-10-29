import { expect, test } from "@playwright/test";
import { card, grid, listAgents, openAgents, roomOf } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

test("Your agents shows one card per chat with its name, model and status", async ({ page, request }) => {
  const chats = (await listAgents(request)).filter((agent) => agent.kind === "chat");
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

test("Jobs lists each job under its agent, working jobs first in each group", async ({ page, request }) => {
  const jobs = (await listAgents(request)).filter((agent) => agent.kind === "job");
  await openAgents(page);
  await page.getByRole("tab", { name: /Jobs/ }).click();
  await expect(page).toHaveURL(/#\/agents\/jobs$/);
  if (!jobs.length) {
    await expect(page.getByText("No jobs yet.")).toBeVisible();
    return;
  }
  await expect(grid(page).getByRole("gridcell")).toHaveCount(jobs.length);
  for (const job of jobs) if (job.parent) await expect(card(page, job)).toContainText(`in ${job.parent.name}`);
  const order = await grid(page).locator("[data-jobs-of], [role=gridcell]").evaluateAll((els) => els.map((el) => (el.tagName === "H2" ? "|" : (el as HTMLElement).dataset.status)));
  for (const group of order.join(",").split("|")) {
    const statuses = group.split(",").filter(Boolean);
    const firstIdle = statuses.indexOf("idle");
    if (firstIdle >= 0) expect(statuses.slice(firstIdle).includes("working")).toBe(false);
  }
  for (const job of jobs) if (job.parent) await expect(grid(page).locator(`[data-jobs-of="${job.parent.id}"]`)).toHaveText(job.parent.name);
});

test("the grid has Buzz's measures: a 768 px column, 192 px tracks, 244 px cards with a 24 px radius", async ({ page, request }) => {
  const chats = (await listAgents(request)).filter((agent) => agent.kind === "chat");
  test.skip(!chats.length, "no chats on this server");
  await openAgents(page);
  const first = card(page, chats[0]!);
  const box = (await first.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(244);
  expect(box.width).toBeGreaterThanOrEqual(192);
  expect(await first.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("24px");
  const toolbar = (await page.getByRole("tab", { name: /Your agents/ }).boundingBox())!;
  const button = (await page.getByRole("button", { name: "New agent" }).boundingBox())!;
  expect(Math.round(button.x + button.width - toolbar.x)).toBe(720);
});

test("a card opens its configuration, and Message opens an agent's DM or a job's pane beside its agent's DM", async ({ page, request }) => {
  const agents = await listAgents(request);
  const chat = agents.find((agent) => agent.kind === "chat");
  test.skip(!chat, "no chats on this server");
  await openAgents(page);
  await card(page, chat!).click({ position: { x: 40, y: 120 } });
  await expect(page).toHaveURL(new RegExp(`#/agents/${chat!.id}$`));
  await expect(card(page, chat!)).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("agent-config").getByRole("button", { name: "Message" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${roomOf(chat!.id)}$`));
  const job = agents.find((agent) => agent.kind === "job" && agent.parent);
  if (!job) return;
  await openAgents(page, "jobs");
  await card(page, job).click({ position: { x: 40, y: 120 } });
  await expect(page).toHaveURL(new RegExp(`#/agents/${encodeURIComponent(job.id)}$`));
  await expect(page.getByRole("tab", { name: /Jobs/ })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("agent-config").getByRole("button", { name: "Message" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${roomOf(job.parent!.id)}\\?thread=${encodeURIComponent(job.id)}$`));
});

test("the ... button and a right click open the same menu, with Stop only while working", async ({ page, request }) => {
  const agents = (await listAgents(request)).filter((agent) => agent.kind === "chat");
  test.skip(!agents.length, "no chats on this server");
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
  const target = agents.find((agent) => agent.kind === "chat") ?? agents[0];
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
  const chats = (await listAgents(request)).filter((agent) => agent.kind === "chat");
  test.skip(chats.length < 2, "needs two chats");
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

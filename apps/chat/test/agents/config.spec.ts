import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { card, grid, listAgents, openAgents, type Agent } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

/** The AgentConfig fields the specs read; the full type is web/src/lib/api/types.ts. */
interface Config {
  runs: { host: string; cwd: string; thread: string };
  board: { chat: string; chatName: string; own: boolean; steps: { open: number; done: number }; openTodos: { id: string; text: string }[]; goals: { id: string; text: string }[] } | null;
  folder: { agent: string; memory: { entries: unknown[] } } | null;
  memory: { kind: "none" | "agent"; note: string; related: { path: string }[] };
  instructions: { files: { path: string }[] };
  swarm: { jobs: { id: string; name: string; kind: string }[]; duties: { id: string; name: string }[]; rooms: { id: string; name: string }[] };
}

const configOf = async (request: APIRequestContext, id: string): Promise<Config> => {
  const response = await request.get(`/api/agents/${encodeURIComponent(id)}/config`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Config;
};
const panel = (page: Page) => page.getByTestId("agent-config");
const section = (page: Page, name: string) => panel(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const tail = (path: string) => path.split("/").filter(Boolean).at(-1)!;

/** The chat with the most to show: a board and jobs if any has them. */
async function richChat(request: APIRequestContext): Promise<{ chat: Agent; config: Config } | null> {
  const chats = (await listAgents(request)).filter((agent) => agent.kind === "chat");
  let best: { chat: Agent; config: Config; score: number } | null = null;
  for (const chat of chats.slice(0, 8)) {
    const config = await configOf(request, chat.id);
    const score = (config.board ? 2 : 0) + (config.swarm.jobs.length ? 1 : 0) + (config.swarm.duties.length ? 1 : 0);
    if (!best || score > best.score) best = { chat, config, score };
  }
  return best;
}

test("the agent's page shows its host, home directory, board and memory, and each tab reads its own data", async ({ page, request }) => {
  const found = await richChat(request);
  test.skip(!found, "no chats on this server");
  const { chat, config } = found!;
  await openAgents(page);
  await card(page, chat).click({ position: { x: 40, y: 120 } });
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("main-panel").getByTestId("agent-config")).toHaveAttribute("data-agent-id", chat.id);
  await expect(panel(page).getByRole("tab")).toHaveText(["Overview", "Work", "Jobs", "Board", "Memory", "Instructions"]);

  await expect(panel(page).locator('[data-fact="host"]')).toContainText(config.runs.host);
  await expect(panel(page).locator('[data-fact="cwd"] code')).toHaveAttribute("title", config.runs.cwd);
  await expect(panel(page).locator('[data-fact="cwd"]').getByRole("button", { name: "Copy working directory" })).toBeVisible();
  await expect(panel(page).locator('[data-fact="memory"]')).toContainText(config.folder ? "memor" : "None of its own");
  if (config.board) await expect(panel(page).locator('[data-fact="board"]')).toContainText(`${config.board.steps.open} open`);
  else await expect(panel(page).locator('[data-fact="board"]')).toContainText("No board");

  await section(page, "Work").click();
  await expect(page).toHaveURL(/section=work/);
  await expect(panel(page).getByRole("tabpanel")).toContainText(config.runs.thread);
  for (const room of config.swarm.rooms) await expect(panel(page).getByRole("link", { name: room.name })).toBeVisible();

  await section(page, "Memory").click();
  if (config.folder) await expect(panel(page).getByTestId("agent-memory")).toBeVisible();
  else await expect(panel(page).locator('[data-memory="none"]')).toContainText("No memory of its own");
  for (const file of config.memory.related) await expect(panel(page).locator(`li[data-path="${file.path}"]`)).toBeVisible();

  await section(page, "Instructions").click();
  for (const file of config.instructions.files) await expect(panel(page).locator(`li[data-path="${file.path}"]`)).toContainText(tail(file.path));

  await section(page, "Jobs").click();
  await expect(page).toHaveURL(/section=jobs/);
  for (const job of config.swarm.jobs.slice(0, 5)) await expect(panel(page).locator(`li[data-job-id="${job.id}"]`)).toContainText(job.name.slice(0, 20));
  for (const duty of config.swarm.duties) await expect(panel(page).locator(`li[data-duty-id="${duty.id}"]`)).toContainText(duty.name);

  await section(page, "Board").click();
  if (config.board) {
    for (const todo of config.board.openTodos) await expect(panel(page).getByRole("tabpanel")).toContainText(todo.text);
    await panel(page).getByRole("tabpanel").getByRole("link", { name: "Open board" }).click();
    await expect(page).toHaveURL(new RegExp(`#/board/${config.board.chat}$`));
    await page.goBack();
    await expect(panel(page)).toBeVisible();
  }
});

test("the page header names the agent once with its state, model, Message and a menu", async ({ page, request }) => {
  const chat = (await listAgents(request)).find((agent) => agent.kind === "chat" && agent.model);
  test.skip(!chat, "no chat with a model on this server");
  await openAgents(page);
  await page.goto(`/#/agents/${chat!.id}`);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: chat!.name, exact: true, level: 1 })).toHaveCount(1);
  await expect(panel(page).locator(".identity .line")).toHaveText({ working: "Working", sleeping: "Waiting", failed: "Failed", idle: "Idle" }[chat!.status]);
  const toolbar = panel(page).getByRole("toolbar", { name: "Agent actions" });
  await expect(toolbar.locator(".model")).toContainText(chat!.model!.label);
  await expect(toolbar.getByRole("button", { name: "Message" })).toBeVisible();
  await toolbar.getByRole("button", { name: `Actions for ${chat!.name}` }).click();
  const expected = [...(chat!.status === "working" || chat!.status === "sleeping" ? ["Stop"] : []), "Archive"];
  for (const label of expected) await expect(page.getByRole("menu").getByRole("menuitem", { name: label })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a page link opens on its own tab, back returns to the grid and forward opens it again", async ({ page, request }) => {
  const chat = (await listAgents(request)).find((agent) => agent.kind === "chat");
  test.skip(!chat, "no chats on this server");
  await openAgents(page);
  await page.goto(`/#/agents/${chat!.id}?section=memory`);
  await expect(panel(page)).toBeVisible();
  await expect(section(page, "Memory")).toHaveAttribute("aria-selected", "true");
  await page.goto("/#/agents");
  await expect(panel(page)).toHaveCount(0);
  await expect(grid(page)).toBeVisible();
  await page.goBack();
  await expect(panel(page)).toBeVisible();
  await expect(section(page, "Memory")).toHaveAttribute("aria-selected", "true");
});

test("old section links from the side panel land on the tab that replaced them", async ({ page, request }) => {
  const chat = (await listAgents(request)).find((agent) => agent.kind === "chat");
  test.skip(!chat, "no chats on this server");
  for (const [old, next, tab] of [["runs", "work", "Work"], ["swarm", "jobs", "Jobs"]] as const) {
    await page.goto(`/#/agents/${chat!.id}?section=${old}`);
    await expect(section(page, tab)).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`#/agents/${chat!.id}\\?section=${next}$`));
  }
});

test("a duty run's configuration names its coordinator and shares its chat's board", async ({ page, request }) => {
  const agents = await listAgents(request);
  let duty: { id: string; chat: Agent } | null = null;
  for (const chat of agents.filter((agent) => agent.kind === "chat").slice(0, 8)) {
    const job = (await configOf(request, chat.id)).swarm.jobs.find((j) => j.kind === "duty");
    if (job) {
      duty = { id: job.id, chat };
      break;
    }
  }
  test.skip(!duty, "no duty runs on this server");
  await page.goto(`/#/agents/${encodeURIComponent(duty!.id)}`);
  await expect(panel(page)).toBeVisible({ timeout: 20_000 });
  await expect(card(page, { id: duty!.id })).toHaveCount(0);
  await expect(panel(page)).toContainText("duty run");
  await expect(panel(page).locator('[data-fact="board"]')).toContainText(`Board of ${duty!.chat.name}`);
  await section(page, "Jobs").click();
  await panel(page).getByRole("tabpanel").getByRole("link", { name: duty!.chat.name }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${duty!.chat.id}$`));
});

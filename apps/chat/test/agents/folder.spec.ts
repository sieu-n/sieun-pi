import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { card, listAgents, openAgents, uniqueName, type Agent } from "./helpers.ts";

/**
 * The agent folder on the Agents card: the owner edits Vent's brief and memory, and a job of Vent shows the same folder read-only.
 * The tests share Vent's one folder on the fixture server, so they run in order and put the brief back when they end.
 */
test.describe.configure({ mode: "serial", retries: 1 });

/** The AgentFolder fields the spec reads; the full type is web/src/lib/api/types.ts. */
interface Folder {
  agent: string;
  brief: { path: string; text: string };
  memory: { path: string; entries: { id: string; kind: string; title: string; content: string; source: string }[] };
}

const panel = (page: Page) => page.getByTestId("agent-config");
const brief = (page: Page) => panel(page).getByTestId("agent-brief");
const memory = (page: Page) => panel(page).getByTestId("agent-memory");

async function vent(request: APIRequestContext): Promise<Agent> {
  const found = (await listAgents(request)).find((agent) => agent.id === "ag_vent" || (agent.kind === "chat" && agent.name === "Vent"));
  expect(found, "the fixture seeds Vent").toBeTruthy();
  return found!;
}
async function folderOf(request: APIRequestContext, id: string): Promise<Folder> {
  const response = await request.get(`/api/agents/${encodeURIComponent(id)}/folder`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Folder;
}
async function putBrief(request: APIRequestContext, id: string, text: string): Promise<void> {
  const response = await request.put(`/api/agents/${encodeURIComponent(id)}/brief`, { data: { text } });
  expect(response.ok()).toBeTruthy();
}
async function openCard(page: Page, agent: Agent) {
  await openAgents(page);
  await card(page, agent).click({ position: { x: 40, y: 120 } });
  await expect(panel(page)).toBeVisible();
}

test("the owner writes Vent's brief from its first message, saves it and sees it after a reload", async ({ page, request }) => {
  const agent = await vent(request);
  const before = (await folderOf(request, agent.id)).brief.text;
  await putBrief(request, agent.id, "");
  try {
    const purpose = ((await (await request.get(`/api/agents/${agent.id}/config`)).json()) as { identity: { purpose: { text: string } | null } }).identity.purpose;
    await openCard(page, agent);
    await expect(brief(page)).toHaveAttribute("data-brief", "empty");
    await expect(brief(page)).toContainText(`Loaded into every thread of ${agent.name}`);

    await brief(page).getByRole("button", { name: "Write a brief" }).click();
    const editor = brief(page).getByRole("textbox", { name: `Brief of ${agent.name}` });
    if (purpose) await expect(editor).toHaveValue(purpose.text.trim());
    await brief(page).getByRole("button", { name: "Cancel" }).click();
    expect((await folderOf(request, agent.id)).brief.text).toBe("");

    const text = `${uniqueName("Watch the canary relay")} and flag a gap over an hour on the board.`;
    await brief(page).getByRole("button", { name: "Write a brief" }).click();
    await editor.fill(text);
    await brief(page).getByRole("button", { name: "Save" }).click();
    await expect(brief(page)).toHaveAttribute("data-brief", "set");
    await expect(brief(page)).toContainText(text);
    expect((await folderOf(request, agent.id)).brief.text.trim()).toBe(text);

    await page.reload();
    await expect(brief(page)).toContainText(text, { timeout: 20_000 });
    await brief(page).getByRole("button", { name: "Edit" }).click();
    await expect(editor).toHaveValue(text);
  } finally {
    await putBrief(request, agent.id, before);
  }
});

test("the owner adds a memory to Vent, sees it listed and deletes it", async ({ page, request }) => {
  const agent = await vent(request);
  const title = uniqueName("Relay gaps");
  const content = "The Mac sleeps every night, so a relay gap under an hour is normal.";
  await openCard(page, agent);
  await panel(page).getByRole("tab", { name: /^Memory/ }).click();
  await expect(memory(page)).toContainText(`Loaded into every thread of ${agent.name}`);

  await memory(page).getByRole("button", { name: "Add memory" }).click();
  await memory(page).getByRole("textbox", { name: "Memory title" }).fill(title);
  await memory(page).getByRole("textbox", { name: "Memory content" }).fill(content);
  await memory(page).getByRole("button", { name: "Add", exact: true }).click();
  const row = memory(page).locator("li[data-entry-id]", { hasText: title });
  await expect(row).toContainText(content);
  await expect(row).toContainText("From owner");
  const saved = (await folderOf(request, agent.id)).memory.entries.find((entry) => entry.title === title);
  expect(saved?.source).toBe("owner");

  await page.reload();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: `Delete ${title}` }).click();
  await row.getByRole("group", { name: "Confirm delete" }).getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  expect((await folderOf(request, agent.id)).memory.entries.some((entry) => entry.title === title)).toBe(false);
});

test("a job of Vent shows Vent's folder read-only and links back to Vent", async ({ page, request }) => {
  const agent = await vent(request);
  const config = (await (await request.get(`/api/agents/${agent.id}/config`)).json()) as { swarm: { jobs: { id: string }[] } };
  const job = config.swarm.jobs[0];
  test.skip(!job, "Vent has no jobs on this server");
  await page.goto(`/#/agents/${encodeURIComponent(job!.id)}`);
  await expect(panel(page)).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).getByTestId("folder-owner")).toContainText(`belongs to ${agent.name}`);
  await expect(brief(page)).toBeVisible();
  await expect(brief(page).getByRole("button")).toHaveCount(0);

  await panel(page).getByRole("tab", { name: /^Memory/ }).click();
  await expect(memory(page)).toBeVisible();
  await expect(memory(page).getByRole("button", { name: "Add memory" })).toHaveCount(0);
  await panel(page).getByTestId("folder-owner").getByRole("link", { name: agent.name }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agent.id}`));
});

import { expect, test } from "@playwright/test";
import { agentPage, agentsFilter, agentsSidebar, card, openAgents, sidebarRow, uniqueName } from "./helpers.ts";

test.describe.configure({ retries: 1 });

type Made = { id: string; name: string };
/** A fresh agent per test, so the archive and rename checks never touch another spec's agents. */
async function makeAgent(request: import("@playwright/test").APIRequestContext, prefix: string): Promise<Made> {
  const response = await request.post("/api/agents", { data: { name: uniqueName(prefix) } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Made;
}

test("Archive on a card asks nothing, its toast's Undo brings the agent back, and the Archived tab unarchives it", async ({ page, request }) => {
  const agent = await makeAgent(request, "spec archive");
  await openAgents(page);
  const cell = card(page, agent);
  await cell.getByRole("button", { name: `Actions for ${agent.name}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Archive" }).click();
  await expect(cell).toHaveCount(0);
  const toast = page.getByText(`Archived ${agent.name}`);
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, agent)).toBeVisible();

  await card(page, agent).getByRole("button", { name: `Actions for ${agent.name}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Archive" }).click();
  await expect(card(page, agent)).toHaveCount(0);
  await agentsFilter(page).getByRole("tab", { name: /Archived/ }).click();
  await expect(page).toHaveURL(/#\/agents\?show=archived$/);
  const archived = card(page, agent);
  await expect(archived).toBeVisible();
  await archived.click({ button: "right", position: { x: 40, y: 120 } });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Unarchive", "Rename"]);
  await page.getByRole("menu").getByRole("menuitem", { name: "Unarchive" }).click();
  await expect(card(page, agent)).toHaveCount(0);
  await agentsFilter(page).getByRole("tab", { name: /Active/ }).click();
  await expect(card(page, agent)).toBeVisible();
  await request.patch(`/api/c/dm_${agent.id.slice(3)}`, { data: { archived: true } });
});

test("an agent's page renames it from its menu or a double-click, and an archived agent's page offers Unarchive", async ({ page, request }) => {
  const agent = await makeAgent(request, "spec rename");
  await page.goto(`/#/agents/${agent.id}`);
  const header = agentPage(page).getByRole("heading", { level: 1 });
  await expect(header).toHaveText(agent.name, { timeout: 20_000 });
  await header.dblclick();
  const dialog = page.getByRole("dialog", { name: "Rename agent" });
  await expect(dialog).toBeVisible();
  const renamed = uniqueName("Spec Renamed");
  await dialog.getByRole("textbox").fill(renamed);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(header).toHaveText(renamed);
  await expect(sidebarRow(page, agent)).toContainText(renamed);

  await agentPage(page).getByRole("button", { name: `Actions for ${renamed}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Archive" }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await page.goto(`/#/agents/${agent.id}`);
  await expect(agentPage(page).getByText("Archived", { exact: true })).toBeVisible({ timeout: 20_000 });
  await agentPage(page).getByRole("button", { name: "Unarchive" }).click();
  await expect(agentPage(page).getByRole("button", { name: "Message" })).toBeVisible();
  await request.patch(`/api/c/dm_${agent.id.slice(3)}`, { data: { archived: true } });
});

test("a sidebar row opens the agent's menu on right-click and from its hover button", async ({ page, request }) => {
  const agent = await makeAgent(request, "spec sidebar");
  await openAgents(page);
  const row = sidebarRow(page, agent);
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Message", "Rename", "Archive"]);
  await page.keyboard.press("Escape");
  await row.hover();
  await agentsSidebar(page).getByRole("button", { name: `${agent.name} options` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("dialog", { name: "Rename agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(agentsSidebar(page).getByRole("link", { name: "Archived" })).toBeVisible();
  await request.patch(`/api/c/dm_${agent.id.slice(3)}`, { data: { archived: true } });
});

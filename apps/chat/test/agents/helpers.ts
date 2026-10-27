import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** The AgentSummary fields the specs read; the full type is web/src/lib/api/types.ts. */
export interface Agent {
  id: string;
  kind: "chat" | "job";
  name: string;
  model: { provider: string; id: string; label: string } | null;
  thinkingLevel: string | null;
  status: "working" | "idle" | "sleeping" | "failed";
  parent: { id: string; name: string } | null;
  archived: boolean;
}

/** The server's own list through the dev proxy, so each spec checks the page against the same data in fixture mode and on pi-host. */
export async function listAgents(request: APIRequestContext): Promise<Agent[]> {
  const response = await request.get("/api/agents");
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as Agent[]).filter((agent) => !agent.archived);
}

export const grid = (page: Page) => page.getByRole("grid");
export const card = (page: Page, agent: Pick<Agent, "id">) => page.locator(`[role="gridcell"][data-agent-id="${agent.id}"]`);

/** The first load in a fresh browser pulls every module from the dev server, which can take longer than the default 5 s. */
export async function openAgents(page: Page, tab: "yours" | "jobs" = "yours") {
  await page.goto(tab === "jobs" ? "/#/agents/jobs" : "/#/agents");
  await expect(page.getByRole("tab", { name: tab === "jobs" ? /Jobs/ : /Your agents/ })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
}

/** A name no other run uses, so parallel specs and reruns never collide. */
export const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

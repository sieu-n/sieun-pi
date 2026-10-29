import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Fixture ids, seeded by `npm run fixture` (apps/chat/API.md, Fixture mode). */
export const VENT = "0f1e0000-0000-4000-8000-000000000001";
export const VP = "0f1e0000-0000-4000-8000-000000000002";
export const CRAWLER = "0f1e0000-0000-4000-8000-000000000003";
export const FRONTEND = "0f1e0000-0000-4000-8000-000000000004";
export const VENT_JOB = `${VENT}:14`;

export const conversation = (page: Page) => page.locator("section.conversation");
export const row = (page: Page, id: string) => conversation(page).locator(`[data-message-id="${id}"]`);
export const composerInput = (scope: Page | ReturnType<Page["locator"]>) => scope.getByTestId("composer-input");

/**
 * Opens a hash route and waits for the timeline. The box's Chrome sometimes drops in-flight dev-server module loads with
 * ERR_NETWORK_CHANGED, which leaves a blank page, so one reload follows a page that never mounts.
 */
export async function open(page: Page, hash: string, ready = "timeline"): Promise<void> {
  await page.goto(`/${hash}`);
  const timeline = page.getByTestId(ready).first();
  try {
    await timeline.waitFor({ timeout: 10_000 });
  } catch {
    await page.reload();
    await expect(timeline).toBeVisible({ timeout: 15_000 });
  }
}

/** A fresh word, so a spec's sends never match another run's on the shared fixture server. */
export const tag = (): string => Math.random().toString(36).slice(2, 8);

export const rgb = (page: Page, selector: string, prop: string) =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** The comm thread that answers an agent's DM (agent-model.md phase 4): DM turns run there, and its work thread gets only handed work. */
export async function commThread(request: APIRequestContext, agentId: string, room: string): Promise<string> {
  let thread: string | undefined;
  await expect.poll(async () => {
    const agents = (await (await request.get("/api/agents")).json()) as { id: string; comm?: { room: string; thread: string }[] }[];
    thread = agents.find((a) => a.id === agentId)?.comm?.find((c) => c.room === room)?.thread;
    return thread;
  }, { timeout: 10_000 }).toBeTruthy();
  return thread!;
}

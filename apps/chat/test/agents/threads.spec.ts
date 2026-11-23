import { expect, test } from "@playwright/test";
import { agentPage, uniqueName } from "./helpers.ts";

/**
 * An agent's Threads tab: its main thread, what its threads cost over 7 days split by kind, the board.wakes set on its threads, and where it
 * runs, folded. A wake is set on a new test agent's main thread through the board skill's route, on the run's own fixture.
 */
const AGENT = "ag_ai-harness-developer-environment-vp";

test("the Threads tab lists the main thread, the 7 days by kind, and keeps where it runs folded", async ({ page, request }) => {
  const config = (await (await request.get(`/api/agents/${AGENT}/config`)).json()) as { usage: { cost: number; split: Record<string, { turns: number }> } | null };
  await page.goto(`/#/agents/${AGENT}?section=threads`);
  const tab = agentPage(page).getByRole("tabpanel");
  await expect(tab.getByTestId("agent-threads").getByRole("link", { name: "Main thread" })).toBeVisible();
  const usage = tab.getByTestId("agent-usage");
  await expect(usage.locator("[data-usage-total]")).toContainText(/^\$\d/);
  if (config.usage && config.usage.split.jobs!.turns > 0) await expect(usage.locator('[data-usage="jobs"]')).toContainText("thread");
  const where = tab.getByTestId("where-it-runs");
  const toggle = where.getByRole("button", { name: /Where it runs/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(where.getByText("pi-host socket")).toHaveCount(0);
  await toggle.click();
  await expect(where.getByText("pi-host socket")).toBeVisible();
});

test("a wake set on an agent's main thread shows on its Threads tab with its note", async ({ page, request }) => {
  const made = (await (await request.post("/api/agents", { data: { name: uniqueName("wake agent"), test: true } })).json()) as { id: string; thread: string };
  const at = Date.now() + 3 * 3_600_000;
  const note = `look at the relay ${Date.now().toString(36)}`;
  try {
    await page.goto(`/#/agents/${made.id}?section=threads`);
    const wakes = agentPage(page).getByRole("tabpanel").getByTestId("agent-wakes");
    await expect(wakes).toContainText("has a board.wake set");
    expect((await request.post(`/api/threads/${made.thread}/wakes`, { data: { on: { kind: "time", at }, note } })).ok()).toBe(true);
    await page.reload();
    const row = wakes.locator(`[data-wake="${made.thread}"]`);
    await expect(row).toHaveAttribute("data-wake-kind", "time");
    await expect(row.getByRole("link", { name: "Main thread" })).toBeVisible();
    await expect(row).toContainText("wakes at ");
    await expect(row).toContainText(note);
  } finally {
    await request.patch(`/api/c/${encodeURIComponent(made.id)}`, { data: { archived: true } });
  }
});

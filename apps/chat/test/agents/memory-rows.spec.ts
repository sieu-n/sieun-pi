import { expect, test } from "@playwright/test";

/**
 * The Memory tab draws a screen of rows at once and the rest over the next frames (AgentMemory.svelte `drawn`): every entry still ends up
 * drawn, and the count and search read every entry, not the rows drawn so far.
 */
const ENTRIES = 150;

test("a long memory draws its first rows, then every entry, and search counts every entry", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const agent = (await (await page.request.post("/api/agents", { data: { name: `memory rows ${tag}`, test: true } })).json()) as { id: string; name: string };
  for (let i = 0; i < ENTRIES; i++) {
    const res = await page.request.post(`/api/agents/${agent.id}/memory`, {
      data: { title: `row ${String(i).padStart(3, "0")} ${i % 10 === 0 ? "tenth" : "plain"}`, content: `Entry ${i} of the long memory.\nIts second line.` },
    });
    expect(res.ok()).toBeTruthy();
  }
  await page.goto(`/#/agents/${agent.id}?section=knowledge`);
  const memory = page.getByTestId("agent-memory");
  const rows = memory.locator("[data-entry-id]");
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(ENTRIES);
  await expect(memory.getByTestId("memory-search")).toHaveAttribute("placeholder", `Search ${ENTRIES} memories`);

  await memory.getByTestId("memory-search").fill("tenth");
  await expect(memory.getByTestId("memory-count")).toHaveText(`${ENTRIES / 10} of ${ENTRIES} memories match`);
  await expect(rows).toHaveCount(ENTRIES / 10);
  await memory.getByTestId("memory-search").fill("");
  await expect(rows).toHaveCount(ENTRIES);
  // A row far below the first screen is in the list and scrolls into view.
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

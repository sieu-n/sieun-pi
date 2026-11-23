import { expect, test } from "@playwright/test";

/**
 * A long memory shows its first 10 rows and a "Show all N memories" control (owner rule c123, ShowAllList.svelte), which draws every entry;
 * the count and search read every entry, not the rows shown.
 */
const ENTRIES = 150;

test("a long memory shows 10 rows, Show all draws every entry, and search counts every entry", async ({ page }) => {
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
  await expect(rows).toHaveCount(10);
  await expect(memory.getByTestId("memory-search")).toHaveAttribute("placeholder", `Search ${ENTRIES} memories`);
  await memory.getByRole("button", { name: `Show all ${ENTRIES} memories` }).click();
  await expect(rows).toHaveCount(ENTRIES);
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await memory.getByRole("button", { name: "Show fewer memories" }).click();
  await expect(rows).toHaveCount(10);

  await memory.getByTestId("memory-search").fill("tenth");
  await expect(memory.getByTestId("memory-count")).toHaveText(`${ENTRIES / 10} of ${ENTRIES} memories match`);
  await expect(rows).toHaveCount(10);
  await memory.getByRole("button", { name: `Show all ${ENTRIES / 10} memories` }).click();
  await expect(rows).toHaveCount(ENTRIES / 10);
  await memory.getByTestId("memory-search").fill("");
  await expect(rows).toHaveCount(ENTRIES);
});

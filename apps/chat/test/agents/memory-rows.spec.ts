import { expect, test } from "@playwright/test";

/**
 * The Memory tab, apart from skills (owner, t8 answer msg mwwlxbdo: memory "should scale to 10,000s of entries"). It draws the newest 50
 * entries as 10 rows and a "Show all" control (owner rule c123, ShowAllList.svelte), "Show older" reads the next page from the server, and a
 * search runs on the server over the whole store, best match first.
 */
const ENTRIES = 150;

test("the Memory tab shows the newest page in 10 rows, reads older pages, and searches the whole store on the server", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const agent = (await (await page.request.post("/api/agents", { data: { name: `memory rows ${tag}`, test: true } })).json()) as { id: string; name: string };
  for (let i = 0; i < ENTRIES; i++) {
    const res = await page.request.post(`/api/agents/${agent.id}/memory`, {
      data: { title: `row ${String(i).padStart(3, "0")} ${i % 10 === 0 ? "tenth" : "plain"}`, content: `Entry ${i} of the long memory.\nIts second line.` },
    });
    expect(res.ok()).toBeTruthy();
  }
  await page.goto(`/#/agents/${agent.id}?section=memory`);
  const memory = page.getByTestId("agent-memory");
  const rows = memory.locator("[data-entry-id]");
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(10);
  await expect(memory.getByTestId("memory-search")).toHaveAttribute("placeholder", `Search ${ENTRIES} memories`);
  await memory.getByRole("button", { name: "Show all 50 memories" }).click();
  await expect(rows).toHaveCount(50);
  await memory.getByTestId("memory-older").click();
  await expect(rows).toHaveCount(100);
  await memory.getByTestId("memory-older").click();
  await expect(rows).toHaveCount(ENTRIES);
  await expect(memory.getByTestId("memory-older")).toHaveCount(0);

  await memory.getByTestId("memory-search").fill("tenth");
  await expect(memory.getByTestId("memory-count")).toHaveText(`The ${ENTRIES / 10} best matches in ${ENTRIES} memories`);
  await memory.getByTestId("memory-search").fill("row 007");
  await expect(rows.first()).toHaveAttribute("data-entry-id", "row_007_plain");
  await memory.getByTestId("memory-search").fill("");
  await expect(rows).toHaveCount(ENTRIES);
  await expect(page.getByTestId("knowledge-skills")).toHaveCount(0);
});

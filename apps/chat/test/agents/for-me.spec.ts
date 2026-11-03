import { expect, test, type Page } from "@playwright/test";
import { uniqueName } from "./helpers.ts";

/**
 * The For <agent> tab on Vent's page: a new DM post shows on its Pending list over the live socket, the owner marks it completed and back,
 * and the row links to the post in its room. Each test reads only its own post, so parallel specs that post to Vent do not move it.
 */
test.describe.configure({ retries: 1 });

const forTab = (page: Page) => page.getByTestId("agent-for-me");
const row = (page: Page, id: string) => forTab(page).locator(`[data-item-id="${id}"]`);

test("a DM post lands on Vent's Pending list live, marks completed and back, and opens at the post", async ({ page, request }) => {
  await page.goto("/#/agents/ag_vent?section=for");
  await expect(page.getByTestId("agent-config").getByRole("tab", { name: "For Vent" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(forTab(page).getByRole("tab", { name: /^Pending/ })).toHaveAttribute("aria-selected", "true");

  const text = uniqueName("Check the relay logs");
  const sent = await request.post("/api/c/dm_vent/send", { data: { text, requestId: uniqueName("for-me") } });
  expect(sent.ok()).toBeTruthy();
  const post = ((await sent.json()) as { item: { id: string } }).item.id;
  const id = `dm_vent/${post}`;

  await expect(row(page, id)).toContainText(text);
  await expect(row(page, id).locator("a[data-for-me-open]")).toHaveAttribute("href", `#/c/dm_vent?m=${post}`);

  await row(page, id).getByRole("button", { name: "Mark completed" }).click();
  await expect(row(page, id)).toHaveCount(0);
  const marked = (await (await request.get("/api/agents/ag_vent/for-me?status=completed")).json()) as { items: { id: string }[] };
  expect(marked.items.map((item) => item.id)).toContain(id);

  await forTab(page).getByRole("tab", { name: /^Completed/ }).click();
  await expect(row(page, id)).toHaveAttribute("data-status", "completed");
  await row(page, id).getByRole("button", { name: "Mark pending again" }).click();
  await expect(row(page, id)).toHaveCount(0);

  await forTab(page).getByRole("tab", { name: /^Pending/ }).click();
  await row(page, id).locator("a[data-for-me-open]").click();
  await expect(page).toHaveURL(new RegExp(`#/c/dm_vent\\?m=${post}$`));
  await expect(page.locator(`[data-message-id="${post}"]`)).toBeVisible();
});

test("a job's page has no For tab", async ({ page, request }) => {
  const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; archived: boolean }[];
  const job = jobs.find((item) => !item.archived);
  test.skip(!job, "no jobs on this server");
  await page.goto(`/#/agents/${encodeURIComponent(job!.id)}`);
  await expect(page.getByTestId("agent-config").getByRole("tab", { name: "Overview" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("agent-config").getByRole("tab", { name: /^For / })).toHaveCount(0);
});

import type { APIRequestContext, Page } from "@playwright/test";
import { CRAWLER, CRAWLER_AGENT, expect, resetFixture, test } from "./helpers";

/** The owner's own plan controls on a board: Add step, rename by double-click, the step menu with Undo, Move up, Add step under and Ask. */
/** The first page load compiles the app in vite, which took 26 s on 11-21 while other builders edited the tree. */
test.describe.configure({ mode: "serial", timeout: 90_000 });

type Step = { id: string; text: string; status: string; children: Step[] };
const plan = async (request: APIRequestContext, server: string): Promise<Step[]> =>
  (await (await request.get(`${server}/api/threads/${CRAWLER}/board`)).json()).board.plan;

test.beforeEach(async ({ request, chatServer }) => {
  await resetFixture(request, chatServer);
  const extra = (await plan(request, chatServer)).filter(step => step.id !== "p1");
  if (extra.length) await request.post(`${chatServer}/api/threads/${CRAWLER}/board`, { data: { ops: extra.map(step => ({ op: "plan_remove", id: step.id })) } });
});

async function addSteps(page: Page, texts: string[]) {
  await page.getByRole("button", { name: "Add step" }).click();
  const field = page.getByRole("textbox", { name: "New step" });
  for (const text of texts) {
    await field.fill(text);
    await field.press("Enter");
    await expect(page.getByRole("region", { name: "To do" })).toContainText(text);
  }
  await field.press("Escape");
  await expect(field).toHaveCount(0);
}

const row = (page: Page, text: string) => page.locator("[data-step]", { hasText: text });

test("the owner adds steps, renames one by double-click and reorders with Move up", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${CRAWLER_AGENT}`);
  await addSteps(page, ["Check the proxy bill", "Rotate the census accounts"]);
  await row(page, "Check the proxy bill").locator(".text").dblclick();
  const rename = page.getByRole("textbox", { name: /^Rename p/ });
  await rename.fill("Check the proxy invoice");
  await rename.press("Enter");
  await expect(row(page, "Check the proxy invoice")).toBeVisible();

  await row(page, "Rotate the census accounts").hover();
  await row(page, "Rotate the census accounts").getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(async () => (await plan(request, chatServer)).map(step => step.text)).toEqual(["Crawl census at 128 slots", "Rotate the census accounts", "Check the proxy invoice"]);
  await expect(page.getByRole("region", { name: "To do" }).locator("[data-step]").first()).toContainText("Rotate the census accounts");
});

test("Mark done and Delete from the step menu each have an Undo, and a delete lands once its toast is gone", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${CRAWLER_AGENT}`);
  await addSteps(page, ["Renew the proxy plan"]);
  const step = row(page, "Renew the proxy plan");
  await step.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark done" }).click();
  await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("region", { name: "To do" })).toContainText("Renew the proxy plan");

  await step.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete step" }).click();
  await expect(step).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(step).toBeVisible();

  await step.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete step" }).click();
  await expect(step).toHaveCount(0);
  await expect.poll(async () => (await plan(request, chatServer)).map(item => item.text), { timeout: 12_000 }).toEqual(["Crawl census at 128 slots"]);
});

test("Add step under puts a step under its goal, and Ask sends the question to the agent's DM", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${CRAWLER_AGENT}`);
  await row(page, "Crawl census at 128 slots").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add step under" }).click();
  const field = page.getByRole("textbox", { name: "New step under p1" });
  await field.fill("Ask pi-pool for one more account");
  await field.press("Enter");
  await field.press("Escape");
  await expect(row(page, "Ask pi-pool for one more account")).toBeVisible();
  expect((await plan(request, chatServer))[0]!.children.map(child => child.text)).toContain("Ask pi-pool for one more account");

  await row(page, "Crawl census at 128 slots").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Ask .* about it$/ }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByRole("textbox", { name: "Your question" }).fill("When does the slot come back?");
  await dialog.getByRole("textbox", { name: "Your question" }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Sent to Crawler VP" })).toBeVisible();
  await expect.poll(async () => JSON.stringify(await (await request.get(`${chatServer}/api/c/dm_crawler-vp/items`)).json())).toContain("About p1");
});

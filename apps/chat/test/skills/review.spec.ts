import { expect, test, type Page } from "@playwright/test";
import type { ReviewDecideBody, ReviewReport } from "../../web/src/lib/api/shared/skills-review.ts";

/**
 * The skills review route against the fixture server's throwaway `fixture` set: the owner walks approve, undo, skip, keep, change target
 * and j/k with the keyboard only. One test walks it all, since each step changes the set the next step reads.
 */
const itemParam = (page: Page): string | null => new URL(page.url().replace("#/", "")).searchParams.get("item");

async function decideBody(page: Page, press: () => Promise<void>): Promise<ReviewDecideBody> {
  const request = page.waitForRequest(req => req.url().includes("/api/skills/review/decide") && req.method() === "POST");
  await press();
  return (await request).postDataJSON() as ReviewDecideBody;
}

test("the owner decides review items with the keyboard and undoes one", async ({ page, request }) => {
  const report = (await (await request.get("/api/skills/review")).json()) as ReviewReport;
  expect(report.set).toBe("fixture");
  expect(report.counts.pending).toBeGreaterThanOrEqual(4);
  const pending = report.items.filter(item => item.status === "pending").map(item => item.id);

  await page.goto("/#/settings/skills/review");
  const item = page.getByTestId("review-item");
  await expect(item).toHaveAttribute("data-item", pending[0]!);
  await expect.poll(() => itemParam(page)).toBe(pending[0]);
  await expect(page.getByTestId("review-position")).toHaveText(`1 of ${report.items.length}`);
  await expect(page.getByTestId("review-mac")).toContainText("Mac");
  await expect(page.getByRole("button", { name: /Approve a/ })).toBeVisible();

  // Approve (a) applies the first item and moves to the next pending one.
  const first = await decideBody(page, () => page.keyboard.press("a"));
  expect(first).toMatchObject({ set: "fixture", id: pending[0], action: "approve" });
  await expect(page.getByText(/^Approved /)).toBeVisible();
  await expect(item).toHaveAttribute("data-item", pending[1]!);
  await expect(page.locator(`[data-jump="${pending[0]}"]`)).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("review-counts")).toContainText("1 approved");

  // Undo (u) on an undecided item puts back the last decision and returns to it.
  await page.keyboard.press("u");
  await expect(item).toHaveAttribute("data-item", pending[0]!);
  await expect(page.locator(`[data-jump="${pending[0]}"]`)).not.toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("review-counts")).toContainText("0 approved");

  // j and k move between items without deciding.
  await page.keyboard.press("j");
  await expect(item).toHaveAttribute("data-item", report.items[report.items.findIndex(entry => entry.id === pending[0]) + 1]!.id);
  await page.keyboard.press("k");
  await expect(item).toHaveAttribute("data-item", pending[0]!);

  // Skip (s), then Keep (e) on the item it moves to.
  await page.locator(`[data-jump="${pending[1]}"]`).click();
  await expect(item).toHaveAttribute("data-item", pending[1]!);
  expect(await decideBody(page, () => page.keyboard.press("s"))).toMatchObject({ id: pending[1], action: "skip" });
  await expect(page.locator(`[data-jump="${pending[1]}"]`)).toHaveAttribute("data-status", "skipped");
  await expect(item).not.toHaveAttribute("data-item", pending[1]!);
  const keptId = itemParam(page);
  const keepBody = await decideBody(page, () => page.keyboard.press("e"));
  expect(keepBody).toMatchObject({ id: keptId, action: "keep" });
  await expect(page.locator(`[data-jump="${keepBody.id}"]`)).toHaveAttribute("data-status", "kept");

  // Change target (t) on a pending item with a copy to act on: set that copy to fold into a named skill, all with keys, then Approve.
  const target = report.items.find(entry => entry.status === "pending" && entry.toAct > 0 && entry.id !== keepBody.id && entry.id !== pending[1])!;
  await page.locator(`[data-jump="${target.id}"]`).click();
  await expect(item).toHaveAttribute("data-item", target.id);
  await page.keyboard.press("t");
  await expect(page.getByTestId("copy-edit").first().locator("select")).toBeFocused();
  const card = page.locator('[data-testid="review-copy"]:is([data-action="delete"], [data-action="fold"])').first();
  const copyId = await card.getAttribute("data-copy");
  await card.locator("select").selectOption("fold");
  const fold = card.getByTestId("copy-edit").getByRole("combobox", { name: /Fold target/ });
  await fold.focus();
  await page.keyboard.type("aaa-target");
  await expect(item).toHaveAttribute("data-item", target.id);
  await page.keyboard.press("Escape");
  await expect(fold).not.toBeFocused();
  const approved = await decideBody(page, () => page.keyboard.press("a"));
  expect(approved).toMatchObject({ id: target.id, action: "approve" });
  expect(approved.overrides?.[copyId!]).toEqual({ action: "fold", foldInto: "aaa-target" });
  await expect(page.locator(`[data-jump="${target.id}"]`)).toHaveAttribute("data-status", "approved");
});

test("the Skills page links to the review", async ({ page }) => {
  await page.goto("/#/settings/skills");
  await page.getByRole("link", { name: "Review cleanup" }).click();
  await expect(page).toHaveURL(/#\/settings\/skills\/review/);
  await expect(page.getByRole("heading", { name: "Review skills cleanup" })).toBeVisible();
});

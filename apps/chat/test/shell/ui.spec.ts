import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/ui");
});

test("a menu opened inside a dialog stacks above the dialog and takes clicks", async ({ page }) => {
  await page.getByRole("button", { name: "Dialog", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Sort:/ }).click();
  await page.getByRole("menuitemradio", { name: "A–Z" }).click();
  await expect(dialog.getByRole("button", { name: "Sort: az" })).toBeVisible();
});

test("the dialog title uses the 16 px label size", async ({ page }) => {
  await page.getByRole("button", { name: "Dialog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create agent" })).toHaveCSS("font-size", "16px");
});

test("an inbox row swaps its time for its action on hover", async ({ page }) => {
  const row = page.locator(".nav-item.inbox").first();
  await expect(row.getByText("9:41 PM")).toBeVisible();
  await expect(row.getByRole("button", { name: "Archive" })).toBeHidden();
  await row.hover();
  await expect(row.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(row.getByText("9:41 PM")).toBeHidden();
});

test("the model picker shows every thinking level inside the popover", async ({ page }) => {
  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  const picker = page.getByRole("dialog", { name: "Model" });
  const box = (await picker.boundingBox())!;
  for (const level of ["Minimal", "Low", "Medium", "High", "Xhigh"]) {
    const tab = (await picker.getByRole("tab", { name: level, exact: true }).boundingBox())!;
    expect(tab.x + tab.width).toBeLessThanOrEqual(box.x + box.width);
  }
});

test("agent avatars draw the seeded mascot", async ({ page }) => {
  const svg = page.locator('[data-gallery="avatars"] .avatar.agent svg').first();
  await expect(svg).toHaveAttribute("viewBox", "0 0 128 128");
});

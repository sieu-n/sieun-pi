import { expect, test } from "@playwright/test";

test("the Skills section groups the fixture inventory by kind and filters it", async ({ page }) => {
  await page.goto("/#/settings/skills");
  await expect(page.getByTestId("skills-summary")).toContainText("6 skills");
  await expect(page.getByRole("heading", { name: "Ours (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Forks (1)" })).toBeVisible();
  await expect(page.getByText("mac did not scan")).toBeVisible();
  await page.getByRole("tab", { name: /Merge or remove/ }).click();
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await page.getByLabel("Filter skills").fill("chrome");
  await expect(page.getByTestId("skill-row")).toHaveCount(1);
});

test("a skill opens in the viewer with its row, and its duplicate opens from there", async ({ page }) => {
  await page.goto("/#/settings/skills");
  await page.locator('[data-skill="us-metal02:auto-sns-agent/.agents/skills/stack/modern-web-guidance"]').click();
  const pane = page.getByTestId("skill-pane");
  await expect(pane).toContainText("Rewritten in place");
  await expect(page).toHaveURL(/view=skill/);
  await pane.getByRole("button", { name: /modern-web-guidance \(upstream on us-metal02\)/ }).click();
  await expect(pane).toContainText("A second copy lives in auto-sns-agent");
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
});

test("a row on another box shows the SKILL.md text the inventory carries", async ({ page }) => {
  await page.goto("/#/settings/skills?view=skill:mac:chrome-extensions");
  await expect(page.getByTestId("skill-pane")).toContainText("This copy is the fixture's carried text");
  await expect(page.getByTestId("skill-pane")).toContainText("Installed with no ask from the owner");
});

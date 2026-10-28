import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, row, tag, VENT } from "./helpers";

/**
 * An agent speaks only through send_message: each call is its own bubble, its other text and steps fold into one line above them, and a
 * turn that sent nothing is only that line, reading "Worked quietly". A thread from before the tool keeps its text bubbles.
 */
test("two send_message calls are two bubbles, and a quiet turn is a fold row with no bubble", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `sender ${tag()}` } })).json()) as { id: string };
  await open(page, `#/c/${agent.id}`);
  const input = composerInput(conversation(page));
  const word = tag();
  await input.click();
  await page.keyboard.type(`how is the relay ${word}`);
  await page.keyboard.press("Enter");

  const answer = conversation(page).locator('[data-kind="turn"]').filter({ hasText: word });
  const bubbles = answer.locator("[data-sent]");
  await expect(bubbles).toHaveCount(2, { timeout: 15_000 });
  await expect(bubbles.nth(0)).toContainText(`You said: "how is the relay ${word}"`);
  await expect(bubbles.nth(1)).toHaveText("I checked the canary and the relay, and both answer.");
  // The two bubbles stack as one group: the first and the last of it.
  await expect(bubbles.nth(0)).toHaveClass(/\bfirst\b/);
  await expect(bubbles.nth(1)).toHaveClass(/\blast\b/);
  const firstBox = (await bubbles.nth(0).boundingBox())!;
  const secondBox = (await bubbles.nth(1).boundingBox())!;
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height - 1);
  await expect(page.getByTestId("stop")).toBeHidden({ timeout: 15_000 });

  await input.click();
  await page.keyboard.type(`quiet check ${word}`);
  await page.keyboard.press("Enter");
  const quiet = conversation(page).locator('[data-kind="turn"]').last();
  const fold = quiet.locator("[data-fold][data-quiet]");
  await expect(fold).toBeVisible({ timeout: 15_000 });
  await expect(fold.locator("[data-steps] > button")).toHaveText(/Worked quietly\s*· 1 step/);
  await expect(quiet.locator(".msg-bubble")).toHaveCount(0);
  await expect(quiet.getByText("Nothing changed since the last check")).toBeHidden();
  await fold.locator("[data-steps] > button").click();
  await expect(quiet.locator("[data-note-step]")).toContainText("Nothing changed since the last check");

  // A reload draws the same rows from the stored page.
  await page.reload();
  await expect(conversation(page).locator('[data-kind="turn"]').filter({ hasText: word }).locator("[data-sent]")).toHaveCount(2, { timeout: 15_000 });
  await expect(conversation(page).locator('[data-kind="turn"]').last().locator("[data-fold][data-quiet]")).toBeVisible();
});

test("a thread from before send_message keeps its answers as text bubbles with the fold inside", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  const answer = row(page, "t2");
  await expect(answer.locator(".msg-bubble")).toHaveCount(1);
  await expect(answer.locator("[data-sent]")).toHaveCount(0);
  await expect(answer.locator(".msg-bubble [data-steps]")).toBeVisible();
  await expect(answer.locator(".msg-text")).toContainText("The canary relay lost the Mac");
});

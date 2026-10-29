import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, row, tag, VENT } from "./helpers";

/**
 * An agent speaks only through send_message: each call is a post in its DM and its own bubble in the work thread, where its other text
 * and steps fold into one line above them, and a turn that sent nothing posts nothing and is only that line, reading "Worked quietly".
 * A thread from before the tool keeps its text bubbles.
 */
test("two send_message calls are two DM posts and two bubbles in the work thread, and a quiet turn posts nothing and folds", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `sender ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  const input = composerInput(conversation(page));
  const word = tag();
  await input.click();
  await page.keyboard.type(`how is the relay ${word}`);
  await page.keyboard.press("Enter");

  const posts = conversation(page).locator(".row:not(.own)");
  await expect(posts).toHaveCount(2, { timeout: 15_000 });
  await expect(posts.nth(0)).toContainText(`You said: "how is the relay ${word}"`);
  await expect(posts.nth(1).locator(".msg-text")).toHaveText("I checked the canary and the relay, and both answer.");
  await expect(page.getByTestId("stop")).toBeHidden({ timeout: 15_000 });

  await input.click();
  await page.keyboard.type(`quiet check ${word}`);
  await page.keyboard.press("Enter");
  await expect(conversation(page).locator(".row.own").filter({ hasText: `quiet check ${word}` })).toBeVisible();
  await expect(page.getByTestId("stop")).toBeHidden({ timeout: 15_000 });
  await expect(posts).toHaveCount(2);

  // The work thread draws each call as its own bubble of one turn, and the quiet turn as a fold with no bubble.
  await open(page, `#/c/${agent.thread}`);
  const bubbles = conversation(page).locator('[data-kind="turn"]').filter({ hasText: word }).locator("[data-sent]");
  await expect(bubbles).toHaveCount(2, { timeout: 15_000 });
  await expect(bubbles.nth(0)).toHaveClass(/\bfirst\b/);
  await expect(bubbles.nth(1)).toHaveClass(/\blast\b/);
  const firstBox = (await bubbles.nth(0).boundingBox())!;
  const secondBox = (await bubbles.nth(1).boundingBox())!;
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height - 1);
  const quiet = conversation(page).locator('[data-kind="turn"]').last();
  const fold = quiet.locator("[data-fold][data-quiet]");
  await expect(fold).toBeVisible({ timeout: 15_000 });
  await expect(fold.locator("[data-steps] > button")).toHaveText(/Worked quietly\s*· 1 step/);
  await expect(quiet.locator(".msg-bubble")).toHaveCount(0);
  await fold.locator("[data-steps] > button").click();
  await expect(quiet.locator("[data-note-step]")).toContainText("Nothing changed since the last check");

  // A reload of the DM draws the same posts from the room.
  await open(page, `#/c/${agent.room}`);
  await expect(conversation(page).locator(".row:not(.own)")).toHaveCount(2, { timeout: 15_000 });
});

test("a thread from before send_message keeps its answers as text bubbles with the fold inside", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  const answer = row(page, "t2");
  await expect(answer.locator(".msg-bubble")).toHaveCount(1);
  await expect(answer.locator("[data-sent]")).toHaveCount(0);
  await expect(answer.locator(".msg-bubble [data-steps]")).toBeVisible();
  await expect(answer.locator(".msg-text")).toContainText("The canary relay lost the Mac");
});

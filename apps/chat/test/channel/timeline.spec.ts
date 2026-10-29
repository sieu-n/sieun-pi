import { expect, test } from "@playwright/test";
import { conversation, open, row, VENT, VENT_JOB, VP } from "./helpers";

test("a thread draws every message as a bubble, the owner's on the right in the soft accent", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  const own = row(page, "e2");
  const answer = row(page, "t2");
  await expect(own).toBeVisible();
  await expect(answer).toContainText("The canary relay lost the Mac");
  const ownBubble = own.locator(".bubble").first();
  const theirBubble = answer.locator(".bubble").first();
  expect(await ownBubble.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(232, 240, 205)");
  expect(await theirBubble.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(243, 243, 244)");
  const ownBox = (await ownBubble.boundingBox())!;
  const theirBox = (await theirBubble.boundingBox())!;
  expect(ownBox.x + ownBox.width).toBeGreaterThan(theirBox.x + theirBox.width);
  await expect(own.locator(".byline")).toContainText("You");
  await expect(answer.locator(".byline")).toContainText("Vent");
});

test("day dividers split the days, and the timeline column is at most 52rem", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  await expect(conversation(page).getByRole("separator", { name: "Today" })).toBeVisible();
  expect(await conversation(page).getByRole("separator").count()).toBeGreaterThanOrEqual(3);
  const width = await conversation(page).locator("ol.rows").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(832);
});

test("an agent turn folds its thinking and tool calls into a step line that opens", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  const turn = row(page, "t2");
  const toggle = turn.locator("[data-steps] > button");
  await expect(toggle).toContainText("Thought, ran bash, read");
  await expect(turn.getByText("journalctl", { exact: false })).toBeHidden();
  await toggle.click();
  await expect(turn.getByText("Read the relay log first")).toBeVisible();
  await expect(turn.getByText("journalctl", { exact: false })).toBeVisible();
  await turn.getByRole("button", { name: "Output" }).first().click();
  await expect(turn.getByText("connection reset by peer")).toBeVisible();
});

test("a mermaid answer draws a diagram inside the bubble", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  // A diagram draws once it scrolls near the view (lib/ui/mermaid.ts whenVisible).
  await row(page, "t10").scrollIntoViewIfNeeded();
  await expect(row(page, "t10").locator(".diagram-slot svg").first()).toBeVisible({ timeout: 15_000 });
});

test("a spawned job shows as a thread pill that opens its transcript in the 420 px side pane", async ({ page }) => {
  await open(page, `#/c/${VENT}`);
  const pill = row(page, "t12").locator("[data-thread-pill]");
  await expect(pill).toContainText("Read the canary logs");
  await pill.click();
  await expect(page).toHaveURL(new RegExp(`thread=${encodeURIComponent(VENT_JOB)}`));
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("ECONNREFUSED");
  expect(Math.round((await page.locator("aside").filter({ has: pane }).first().boundingBox())!.width)).toBeGreaterThanOrEqual(400);
  await expect(pane.getByTestId("composer-input")).toHaveAttribute("aria-label", "Reply to thread");
  await page.getByRole("button", { name: /^Close/ }).last().click();
  await expect(pane).toBeHidden();
  await expect(page).not.toHaveURL(/thread=/);
});

test("a link with m= opens the conversation at that message and flashes it for about 2 s", async ({ page }) => {
  await open(page, `#/c/${VENT}?m=e8`);
  const target = row(page, "e8");
  await expect(target).toHaveAttribute("data-flash", "");
  await expect(target).toBeInViewport();
  await expect(target).not.toHaveAttribute("data-flash", "", { timeout: 4_000 });
});

test("a live turn shows typing dots, never half-written text, and the typing row names the agent", async ({ page }) => {
  await open(page, `#/c/${VP}`);
  const live = conversation(page).locator("[data-live]").last();
  await expect(live).toBeVisible({ timeout: 10_000 });
  await expect(live.getByRole("status", { name: "Writing" })).toBeVisible();
  await expect(live.locator(".msg-text")).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(live.locator(".msg-text")).toHaveCount(0);
  await expect(page.locator(".typing")).toContainText("working now");
  await expect(page.getByTestId("header-stop")).toBeVisible();
});

test("an empty channel says so", async ({ page, request }) => {
  const created = await request.post("/api/rooms", { data: { kind: "channel", name: `empty-${Date.now().toString(36)}` } });
  const channel = (await created.json()) as { id: string };
  await open(page, `#/c/${channel.id}`);
  await expect(page.getByTestId("channel-intro")).toContainText(`This is the very beginning of the #empty-`);
});

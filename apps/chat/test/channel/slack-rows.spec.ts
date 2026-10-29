import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, row, tag } from "./helpers";

/** Channels and Solo rooms read like Slack: left-aligned rows with the avatar on a group's first post, while a DM keeps its bubbles. */
test("a channel draws Slack rows: avatar and name on the left of every post, and a thread summary", async ({ page }) => {
  await open(page, "#/c/ch_cutover");
  await expect(page.getByTestId("channel-intro")).toContainText("This is the very beginning of the #pi-cutover channel.");
  await expect(conversation(page).locator('[data-variant="pill"]').first()).toBeVisible();

  const owner = row(page, "p1");
  await expect(owner).toHaveClass(/\bslack\b/);
  await expect(owner.locator(".gutter .avatar")).toHaveAttribute("data-kind", "person");
  await expect(owner.locator(".head .author")).toHaveText("You");
  await expect(owner.locator(".msg-bubble")).toHaveCount(0);
  const avatar = (await owner.locator(".gutter .avatar").boundingBox())!;
  const text = (await owner.locator(".msg-text").boundingBox())!;
  expect(avatar.width).toBe(36);
  expect(text.x).toBeGreaterThan(avatar.x + avatar.width);
  const agentBox = (await row(page, "p6").locator(".gutter .avatar").boundingBox())!;
  expect(Math.abs(agentBox.x - avatar.x)).toBeLessThan(1);

  await expect(row(page, "p6").locator(".gutter .avatar")).toHaveAttribute("data-kind", "agent");
  await expect(row(page, "p6").locator(".head .author")).toHaveText("AI harness developer environment VP");
  await expect(owner.locator("[data-thread-pill]")).toContainText(/\d+ replies/);
});

test("a follow-up post within 5 minutes joins the group with no avatar or name", async ({ page }) => {
  await open(page, "#/c/ch_general");
  const word = tag();
  const input = composerInput(conversation(page));
  for (const n of [1, 2]) {
    await input.click();
    await page.keyboard.type(`pair ${n} ${word}`);
    await page.keyboard.press("Enter");
    await expect(conversation(page).locator('[data-message-id^="p"]').filter({ hasText: `pair ${n} ${word}` })).toBeVisible({ timeout: 8_000 });
  }
  const second = conversation(page).locator(".row.slack").filter({ hasText: `pair 2 ${word}` });
  await expect(second.locator(".avatar")).toHaveCount(0);
  await expect(second.locator(".head")).toHaveCount(0);
  await expect(second.locator(".clock")).toBeHidden();
  await second.hover();
  await expect(second.locator(".clock")).toBeVisible();
});

test("a DM keeps its bubbles", async ({ page, request }) => {
  const agents = (await (await request.get("/api/agents")).json()) as { id: string; room?: string }[];
  const room = agents.find((a) => a.id === "ag_vent")?.room;
  expect(room).toBeTruthy();
  await open(page, `#/c/${room}`);
  const rows = conversation(page).locator("li[data-message-id]");
  await expect(rows.first()).toBeVisible();
  await expect(conversation(page).locator(".msg-bubble").first()).toBeVisible();
  await expect(conversation(page).locator(".row.slack")).toHaveCount(0);
});

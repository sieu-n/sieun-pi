import { expect, test } from "@playwright/test";
import { composerInput, open, row, tag, VENT, VENT_JOB } from "./helpers";

// The dev server transforms every module on a page's first load, which took 13 s of this spec's 30 s on 11-21 while other specs ran.
test.describe.configure({ timeout: 90_000 });

test("a thread reply with Also send to #channel checked shows in the channel under a replied-to-a-thread line, and the box clears after the send", async ({ page }) => {
  const name = `also-${tag()}`;
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string };
  const root = (await (await page.request.post(`/api/c/${room.id}/send`, { data: { text: "Which relay port do we keep?\nsecond line", requestId: `root-${name}` } })).json()) as { item: { id: string } };
  await open(page, `#/c/${room.id}?thread=${root.item.id}`);
  const pane = page.getByTestId("thread-pane");
  const box = pane.getByTestId("also-send");
  await expect(box).toBeVisible();
  await expect(pane.locator(".also-send")).toHaveText(`Also send to #${name}`);

  await composerInput(pane).fill("only in the thread");
  await composerInput(pane).press("Enter");
  await expect(pane.locator("[data-message-id]").filter({ hasText: "only in the thread" })).toHaveCount(1);

  await pane.locator(".also-send label").click();
  await expect(box).toBeChecked();
  await composerInput(pane).fill("port 7070 stays");
  await composerInput(pane).press("Enter");
  await expect(box).not.toBeChecked();

  const reply = pane.locator("[data-message-id]").filter({ hasText: "port 7070 stays" });
  await expect(reply.locator('[data-also-in="thread"]')).toHaveText("Also sent to the channel");
  await expect(pane.locator('[data-also-in="thread"]')).toHaveCount(1);

  const timeline = page.locator("section.conversation [data-testid=timeline]").first();
  await expect(timeline.getByText("only in the thread")).toHaveCount(0);
  const shared = timeline.locator("[data-message-id]").filter({ hasText: "port 7070 stays" });
  await expect(shared).toHaveCount(1);
  const line = shared.locator('[data-also-in="channel"]');
  await expect(line).toHaveText("replied to a thread:Which relay port do we keep?");
  await expect(row(page, root.item.id).locator("[data-thread-pill]")).toContainText("2 replies");

  await page.getByRole("button", { name: "Close thread" }).click();
  await expect(pane).toBeHidden();
  await line.click();
  await expect(page).toHaveURL(new RegExp(`thread=${root.item.id}`));
  await expect(page.getByTestId("thread-pane")).toContainText("port 7070 stays");

  await page.reload();
  await expect(page.locator("section.conversation [data-message-id]").filter({ hasText: "port 7070 stays" }).locator('[data-also-in="channel"]')).toBeVisible();
  await page.request.patch(`/api/rooms/${room.id}`, { data: { archived: true } });
});

test("a job thread's composer has no Also send box", async ({ page }) => {
  await open(page, `#/c/${VENT}?thread=${encodeURIComponent(VENT_JOB)}`);
  await expect(page.getByTestId("thread-pane").getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("thread-pane").getByTestId("also-send")).toHaveCount(0);
});

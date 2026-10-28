import { expect, test } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, row, tag, VENT_JOB, VENT } from "./helpers";

test("Enter sends, Shift Enter adds a line, and the answer streams into a new bubble", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const word = tag();
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`first line ${word}`);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`) && r.method() === "POST");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string };
  expect(body.text).toBe(`first line ${word}\nsecond line`);
  await expect(input).toHaveText("");
  const mine = conversation(page).locator(".row.own").filter({ hasText: word });
  await expect(mine).toBeVisible();
  await expect(conversation(page).locator('[data-kind="turn"]').last()).not.toBeEmpty();
});

test("Stop ends a running answer and the turn reads Response stopped", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `stop ${tag()}` } })).json()) as { id: string };
  await open(page, `#/c/${agent.id}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`slow ${tag()}`);
  await page.keyboard.press("Enter");
  const stop = page.getByTestId("stop");
  await expect(stop).toBeVisible({ timeout: 8_000 });
  const aborted = page.waitForRequest((r) => r.url().endsWith(`/api/c/${agent.id}/abort`));
  await stop.click();
  await aborted;
  await expect(conversation(page).getByText("Response stopped").last()).toBeVisible({ timeout: 8_000 });
  await expect(stop).toBeHidden();
});

test("@ opens the chat and job typeahead, a pick becomes a chip and a recipient, and the send routes the mention", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("ping @Ven");
  const option = page.getByRole("option", { name: /^Vent/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input.locator("[data-chip-id]")).toHaveText("@Vent");
  await expect(conversation(page).locator(".recipients")).toBeVisible();
  await page.keyboard.type(`look at ${tag()}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string; mentions: string[] };
  expect(body.mentions).toEqual([VENT]);
  expect(body.text.startsWith("ping @Vent")).toBe(true);
});

test("the typeahead keeps the caret: arrows move, Enter picks, and typing goes on in the composer", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("@crawl");
  await expect(page.getByRole("option", { name: /^Crawler VP/ })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input.locator("[data-chip-id]")).toHaveText("@Crawler VP");
  await page.keyboard.type("hello");
  await expect(input).toContainText("@Crawler VP\u00a0hello");
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("# opens the channel typeahead", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type("see #pi-cut");
  await page.getByRole("option", { name: /pi-cutover/ }).click();
  await expect(composerInput(conversation(page)).locator("[data-chip-kind=channel]")).toHaveText("#pi-cutover");
});

test("a pasted image shows as a thumbnail and goes out with the message", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await input.evaluate((el) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(conversation(page).locator(".thumb img")).toBeVisible();
  await page.keyboard.type(`picture ${tag()}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { images: { mimeType: string; data: string }[] };
  expect(body.images).toHaveLength(1);
  expect(body.images[0]!.mimeType).toBe("image/png");
  await expect(conversation(page).locator(".thumb")).toHaveCount(0);
});

test("Reply to thread in the side pane sends to the job", async ({ page }) => {
  await open(page, `#/c/${VENT}?thread=${encodeURIComponent(VENT_JOB)}`);
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toContainText("ECONNREFUSED");
  const input = composerInput(pane);
  await input.click();
  const word = tag();
  await page.keyboard.type(`job reply ${word}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${encodeURIComponent(VENT_JOB)}/send`));
  await page.keyboard.press("Enter");
  expect(((await sent).postDataJSON() as { text: string }).text).toBe(`job reply ${word}`);
  await expect(pane.locator(".row.own").filter({ hasText: word })).toBeVisible();
  await expect(row(page, "t12")).toBeVisible();
});

test("a send that waits for a working slot shows its place in the turn queue until the run starts", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `queue ${tag()}` } })).json()) as { id: string };
  await open(page, `#/c/${agent.id}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`queue ${tag()}`);
  await page.keyboard.press("Enter");
  const note = conversation(page).locator(".row.own [data-note]").last();
  await expect(note).toHaveText("Waits at place 3 of 7 for a working slot.");
  await expect(page.locator(".typing")).toContainText("waits at place 3 of 7");
  await expect(conversation(page).locator(".row.own [data-note]")).toHaveCount(0, { timeout: 10_000 });
});

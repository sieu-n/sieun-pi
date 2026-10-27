import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

/**
 * The channel view against the real chat server on pi-host. Run it with
 * APPS_CHAT_URL=http://127.0.0.1:5184 CHAT_SERVER_URL=http://127.0.0.1:5184 CHAT_WEB_PORT=<a vite on that server> npx playwright test test/channel/pihost.spec.ts
 * Each test starts its own chat and archives it after, so the owner's sidebar keeps no test rows.
 */
test.skip(!process.env.APPS_CHAT_URL, "needs APPS_CHAT_URL, the running chat server on pi-host");
test.setTimeout(240_000);

let made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made) await request.patch(`/api/c/${encodeURIComponent(id)}`, { data: { archived: true } });
  made = [];
});

test("a new chat sends its first message to a real agent and the answer streams back into a bubble", async ({ page }) => {
  await open(page, "#/c/new?kind=chat", "composer-input");
  await composerInput(page).click();
  const word = `pong${tag()}`;
  await page.keyboard.type(`Reply with the single word ${word} and nothing else.`);
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/new/, { timeout: 30_000 });
  made.push(decodeURIComponent(page.url().split("#/c/")[1]!.split("?")[0]!));
  await expect(conversation(page).locator(".row.own").filter({ hasText: word })).toBeVisible();
  const answer = conversation(page).locator('[data-kind="turn"]').filter({ hasText: word }).last();
  await expect(answer).toBeVisible({ timeout: 200_000 });
  await expect(answer).not.toHaveAttribute("data-live", "");
});

test("Stop ends a long real answer", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `stop spec ${tag()}` } })).json()) as { id: string };
  made.push(agent.id);
  await open(page, `#/c/${agent.id}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type("Write the numbers from 1 to 400 as words, one per line, with no other text.");
  await page.keyboard.press("Enter");
  const live = conversation(page).locator("[data-live] .msg-text").last();
  await expect(live).toContainText(/\w+/, { timeout: 200_000 });
  await page.getByTestId("stop").click();
  await expect(conversation(page).getByText("Response stopped").last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("stop")).toBeHidden({ timeout: 30_000 });
});

import { expect, test } from "@playwright/test";

/**
 * The board and For you against the real chat server on pi-host. Set APPS_CHAT_URL to that server (http://127.0.0.1:5184) and run the web
 * build against it with CHAT_SERVER_URL; the spec writes one owner note on a probe thread and removes it again.
 */
const server = process.env.APPS_CHAT_URL;
const probe = process.env.APPS_CHAT_PROBE_THREAD;
test.skip(!server || !probe, "APPS_CHAT_URL and APPS_CHAT_PROBE_THREAD name the pi-host chat server and a probe thread");
test.describe.configure({ mode: "serial" });

test("an owner note written on pi-host shows on the board and in For you, and Done and Remove work", async ({ page, request }) => {
  const text = `board e2e note ${Date.now()}`;
  const added = await request.post(`${server}/api/threads/${probe}/board`, { data: { ops: [{ op: "todo_add", text }] } });
  expect(added.ok()).toBeTruthy();
  const board = (await added.json()).board as { todos: { id: string; text: string }[] };
  const note = board.todos.find(todo => todo.text === text)!;
  expect(note).toBeTruthy();
  try {
    await page.goto(`/#/board/${probe}`);
    const asks = page.getByRole("region", { name: "For you" });
    await expect(asks).toContainText(text);

    await page.goto("/#/board/for-you");
    await page.getByRole("button", { name: "For you filters" }).click();
    await page.getByRole("menuitemradio", { name: "Your notes" }).click();
    await page.keyboard.press("Escape");
    const row = page.getByRole("list", { name: "For you asks" }).locator("li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: new RegExp(`^Open ${note.id} from`) }).click();
    await page.getByRole("region", { name: "Ask" }).getByRole("button", { name: "Done" }).click();
    await expect(row).toHaveCount(0);

    await page.goto(`/#/board/${probe}?focus=${note.id}`);
    await expect(page.getByRole("region", { name: "For you" })).toContainText(text);
    await page.locator(`[data-board-id="${note.id}"]`).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText(text)).toHaveCount(0);
  } finally {
    await request.post(`${server}/api/threads/${probe}/board`, { data: { ops: [{ op: "todo_remove", id: note.id }] } }).catch(() => {});
  }
});

test("the check-in control reads the real thread's check-in", async ({ page }) => {
  await page.goto(`/#/board/${probe}`);
  await expect(page.getByRole("region", { name: "Check-in" })).toContainText(/Check-in (every|paused)/);
  await expect(page.getByRole("button", { name: "Check-in settings" })).toBeEnabled();
});

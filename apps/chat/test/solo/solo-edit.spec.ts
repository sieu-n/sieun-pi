import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "../channel/helpers";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const soloGroup = (page: Page) => sidebar(page).locator('[data-section="solo"]');
const soloRowLink = (page: Page, id: string) => soloGroup(page).locator(`a[href="#/c/${id}"]`);

/** A fresh Solo room, so renames and closes never touch the seeded rooms other specs read. */
async function freshRoom(request: APIRequestContext): Promise<{ id: string; name: string; agenda: string }> {
  const agenda = `Settle edit question ${tag()}`;
  const created = await request.post("/api/rooms", { data: { kind: "solo", agenda, members: ["ag_vent"] } });
  expect(created.ok()).toBe(true);
  return (await created.json()) as { id: string; name: string; agenda: string };
}

async function rowMenu(page: Page, id: string) {
  const row = soloRowLink(page, id);
  await row.click({ button: "right" });
  return page.getByRole("menu");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c");
  await page.evaluate(() => localStorage.clear());
});

test("a Solo row's menu renames the room, and the sidebar and header show the new name", async ({ page, request }) => {
  const room = await freshRoom(request);
  await open(page, `#/c/${room.id}`);
  const menu = await rowMenu(page, room.id);
  await menu.getByRole("menuitem", { name: "Rename room" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename room" });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue(room.name);
  const renamed = `Relay pick ${tag()}`;
  await field.fill(renamed);
  await field.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("conversation-title")).toHaveText(renamed);
  await expect(soloRowLink(page, room.id)).toContainText(renamed);
});

test("Edit agenda edits the pinned agenda in place: Enter saves, Esc drops", async ({ page, request }) => {
  const room = await freshRoom(request);
  await open(page, `#/c/${room.id}`);
  const text = page.getByTestId("solo-agenda-text");
  await expect(text).toHaveText(room.agenda);

  await page.getByTestId("solo-agenda").hover();
  await page.getByRole("button", { name: "Edit agenda" }).click();
  const field = page.getByTestId("solo-agenda-field");
  await expect(field).toBeFocused();
  await field.fill("throw this away");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(text).toHaveText(room.agenda);

  await page.getByRole("button", { name: "Room actions" }).click();
  await page.getByRole("menuitem", { name: "Edit agenda" }).click();
  const agenda = `Pick the relay and write it up ${tag()}`;
  await field.fill(agenda);
  const saved = page.waitForRequest((r) => r.url().endsWith(`/api/rooms/${room.id}`) && r.method() === "PATCH");
  await field.press("Enter");
  expect((await saved).postDataJSON()).toEqual({ agenda });
  await expect(text).toHaveText(agenda);
  const stored = ((await (await request.get("/api/rooms")).json()) as { id: string; agenda: string }[]).find((r) => r.id === room.id);
  expect(stored?.agenda).toBe(agenda);
});

test("a Solo row's menu closes the room with Undo in its toast, and Reopen room brings a closed one back", async ({ page, request }) => {
  const room = await freshRoom(request);
  await open(page, `#/c/${room.id}`);
  let menu = await rowMenu(page, room.id);
  await menu.getByRole("menuitem", { name: "Close room" }).click();
  const toast = page.getByRole("status").filter({ hasText: `Closed ${room.name}` });
  await expect(toast).toBeVisible();
  await expect(page.getByTestId("closed-banner")).toBeVisible();
  const done = soloGroup(page).locator('[data-group="done"]').locator(`a[href="#/c/${room.id}"]`);
  await expect(done).toBeVisible();
  await expect(composerInput(conversation(page))).toHaveCount(0);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("closed-banner")).toHaveCount(0);
  await expect(composerInput(conversation(page))).toBeVisible();
  await expect(done).toHaveCount(0);

  menu = await rowMenu(page, room.id);
  await menu.getByRole("menuitem", { name: "Close room" }).click();
  await expect(page.getByTestId("closed-banner")).toBeVisible();
  await expect(done).toBeVisible();
  menu = await rowMenu(page, room.id);
  await expect(menu.getByRole("menuitem", { name: "Rename room" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Reopen room" }).click();
  await expect(page.getByTestId("closed-banner")).toHaveCount(0);
});

test("the Solo section stays with an empty hint and a New Solo room row when no Solo room exists", async ({ page }) => {
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as { type: string; sidebar?: { solo: unknown[] } };
      if (event.sidebar) event.sidebar.solo = [];
      ws.send(JSON.stringify(event));
    });
  });
  await page.reload();
  await expect(page.getByTestId("main-panel")).toBeVisible();
  const group = soloGroup(page);
  await expect(group).toBeVisible();
  await expect(group).toContainText("Group chats with agents around one agenda.");
  await group.getByRole("button", { name: "New Solo room" }).last().click();
  await expect(page).toHaveURL(/#\/c\/new\?kind=solo$/);
});

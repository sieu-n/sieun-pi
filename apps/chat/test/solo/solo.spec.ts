import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "../channel/helpers";

/** Seeded by `npm run fixture`: an open Solo room with Vent and frontend bro, and a closed one with Vent and Crawler VP. */
const RELAY = "so_0f1e0001";
const WIKI = "so_0f1e0002";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const soloGroup = (page: Page) => sidebar(page).locator('[data-section="solo"]');
type Summary = { id: string; name: string; archived: boolean };

/** A fresh Solo room through the API, so a spec that closes or edits a room never changes the seeded ones other specs read. */
async function freshRoom(request: APIRequestContext, members = ["ag_vent"]): Promise<{ id: string; name: string; agenda: string }> {
  const agenda = `Settle spec question ${tag()}`;
  const created = await request.post("/api/rooms", { data: { kind: "solo", agenda, members } });
  expect(created.ok()).toBe(true);
  return (await created.json()) as { id: string; name: string; agenda: string };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/#/c");
  await page.evaluate(() => localStorage.clear());
});

test("New Solo room invites only registered agents, and opens the room with its agenda pinned", async ({ page, request }) => {
  const registered = ((await (await request.get("/api/agents")).json()) as Summary[]).filter((a) => a.id.startsWith("ag_") && !a.archived);
  const jobs = (await (await request.get("/api/jobs")).json()) as Summary[];
  const all = (await (await request.get("/api/conversations")).json()) as (Summary & { kind: string })[];
  expect(registered.length).toBeGreaterThan(1);

  await open(page, "#/c", "main-panel");
  await soloGroup(page).getByRole("button", { name: "New Solo room" }).click();
  const dialog = page.getByRole("dialog", { name: "New Solo room" });
  await expect(dialog).toBeVisible();
  const agenda = `Pick the relay protocol ${tag()}`;
  await dialog.getByLabel("Agenda").fill(agenda);
  await dialog.getByRole("button", { name: "Invite agents" }).click();

  const picker = page.getByRole("dialog", { name: "Invite agents" });
  const options = picker.getByRole("option");
  await expect(options).toHaveCount(registered.length);
  const labels = await options.locator(".label").allInnerTexts();
  expect(labels.sort()).toEqual(registered.map((a) => a.name).sort());
  const outsiders = [...jobs.map((j) => j.name), ...all.filter((c) => c.kind === "job" || c.kind === "solo").map((c) => c.name)];
  for (const name of outsiders) if (!registered.some((a) => a.name === name)) expect(labels).not.toContain(name);

  await picker.getByRole("option", { name: /Vent/ }).click();
  await picker.getByRole("option", { name: /frontend bro/ }).click();
  await page.keyboard.press("Escape");
  await expect(dialog.getByTestId("solo-invite")).toContainText("Vent");
  await expect(dialog.getByTestId("solo-invite")).toContainText("frontend bro");

  const posted = page.waitForRequest((r) => r.url().endsWith("/api/rooms") && r.method() === "POST");
  await dialog.getByRole("button", { name: "Create Solo room" }).click();
  const body = (await posted).postDataJSON() as { kind: string; agenda: string; members: string[] };
  expect(body).toMatchObject({ kind: "solo", agenda });
  expect(body.members.sort()).toEqual(["ag_frontend-bro", "ag_vent"]);

  await expect(page).toHaveURL(/#\/c\/so_[0-9a-f]+$/);
  await expect(page.getByTestId("solo-agenda-text")).toHaveText(agenda);
  await expect(page.getByTestId("solo-members")).toContainText("Vent");
  await expect(page.getByTestId("solo-members")).toContainText("frontend bro");
  const id = page.url().split("/c/")[1]!;
  await expect(soloGroup(page).locator(`a[href="#/c/${id}"]`)).toBeVisible();
});

test("the dialog asks for an agenda and an agent before it creates anything", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await soloGroup(page).getByRole("button", { name: "New Solo room" }).click();
  const dialog = page.getByRole("dialog", { name: "New Solo room" });
  let posted = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/rooms") && r.method() === "POST") posted = true;
  });
  await dialog.getByRole("button", { name: "Create Solo room" }).click();
  await expect(dialog).toContainText("Write what this room should settle");
  await expect(dialog).toContainText("Invite at least one agent");
  expect(posted).toBe(false);
});

test("a Solo room pins its agenda, lists its agents and shows their boards in the side panel", async ({ page }) => {
  await open(page, `#/c/${RELAY}`);
  await expect(page.getByTestId("conversation-title")).toHaveText("relay protocol");
  const bar = page.getByTestId("solo-agenda");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("solo-agenda-text")).not.toBeEmpty();
  const box = await bar.boundingBox();
  const timeline = await page.getByTestId("timeline").first().boundingBox();
  expect(box!.y).toBeLessThan(timeline!.y);
  await expect(page.getByTestId("solo-members").getByRole("button", { name: "Remove Vent" })).toBeVisible();
  await expect(page.getByTestId("solo-members").getByRole("button", { name: "Remove frontend bro" })).toBeVisible();

  await page.getByTestId("board-button").click();
  const pane = page.getByTestId("board-pane");
  await expect(pane).toBeVisible();
  const tabs = page.getByTestId("side-panel").getByRole("tab");
  await expect(tabs).toHaveCount(2);
  const first = await pane.getAttribute("data-board-chat");
  await tabs.nth(1).click();
  await expect(pane).not.toHaveAttribute("data-board-chat", first!);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("aria-label", /^Board of /);
});

test("Close turns the composer into a closed banner, and Reopen brings it back", async ({ page, request }) => {
  const room = await freshRoom(request);
  await open(page, `#/c/${room.id}`);
  await expect(composerInput(conversation(page))).toBeVisible();
  await page.getByTestId("solo-close").click();
  const banner = page.getByTestId("closed-banner");
  await expect(banner).toContainText("You closed this room");
  await expect(composerInput(conversation(page))).toHaveCount(0);
  await expect(page.getByTestId("solo-close")).toHaveCount(0);
  const fold = soloGroup(page).locator('[data-fold="done"]');
  await fold.click();
  await expect(soloGroup(page).locator('[data-group="done"]').locator(`a[href="#/c/${room.id}"]`)).toBeVisible();

  await page.getByTestId("solo-reopen").click();
  await expect(banner).toHaveCount(0);
  await expect(composerInput(conversation(page))).toBeVisible();
  await expect(soloGroup(page).locator('[data-group="done"]').locator(`a[href="#/c/${room.id}"]`)).toHaveCount(0);
});

test("Add agents offers only registered agents not in the room, and a chip's x removes one", async ({ page, request }) => {
  const room = await freshRoom(request);
  await open(page, `#/c/${room.id}`);
  const members = page.getByTestId("solo-members");
  await expect(members).toContainText("Vent");
  await members.getByRole("button", { name: "Add agents" }).click();
  const picker = page.getByRole("dialog", { name: "Add agents" });
  await expect(picker.getByRole("option", { name: /Crawler VP/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /^Vent/ })).toHaveCount(0);
  await picker.getByRole("option", { name: /Crawler VP/ }).click();
  const remove = members.getByRole("button", { name: "Remove Crawler VP" });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(members.getByRole("button", { name: "Remove Vent" })).toBeVisible();
});

test("the Solo group lists open rooms first, closed ones under a folded Done, then the untitled chats", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  const group = soloGroup(page);
  const relay = group.locator(`a[href="#/c/${RELAY}"]`);
  const chat = group.getByRole("link", { name: "New thread" }).first();
  await expect(relay).toBeVisible();
  await expect(chat).toBeVisible();
  expect((await relay.boundingBox())!.y).toBeLessThan((await chat.boundingBox())!.y);

  const fold = group.locator('[data-fold="done"]');
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(`a[href="#/c/${WIKI}"]`)).toHaveCount(0);
  await fold.click();
  const wiki = group.locator('[data-group="done"]').locator(`a[href="#/c/${WIKI}"]`);
  await expect(wiki).toBeVisible();
  expect((await fold.boundingBox())!.y).toBeLessThan((await chat.boundingBox())!.y);
  await wiki.click();
  await expect(page.getByTestId("closed-banner")).toBeVisible();
  await expect(composerInput(conversation(page))).toHaveCount(0);
});

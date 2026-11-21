import { expect, test } from "@playwright/test";
import { open, tag } from "./helpers";

test("New channel makes the room and opens it", async ({ page }) => {
  await open(page, "#/c/new?kind=channel", "main-panel");
  await expect(page.getByLabel("Name")).toBeVisible();
  const name = `room ${tag()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Purpose/).fill("A spec room");
  await page.getByTestId("main-panel").getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(/#\/c\/ch_/);
  const slug = name.replace(" ", "-");
  await expect(page.getByTestId("conversation-title")).toHaveText(slug);
  const intro = page.getByTestId("channel-intro");
  await expect(intro.getByRole("heading", { name: `#${slug}` })).toBeVisible();
  await expect(intro).toContainText(`This is the very beginning of the #${slug} channel.`);
  await expect(intro).toContainText("A spec room");
});

test("Cmd N and an old New chat link open New message, and one agent in To: opens its DM", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+n`);
  await expect(page).toHaveURL(/#\/c\/new\?kind=dm$/);
  await expect(page.getByRole("heading", { name: "New message" })).toBeVisible();
  await page.goto("/#/c/new?kind=chat");
  await expect(page.getByRole("heading", { name: "New message" })).toBeVisible();
  const to = page.getByRole("combobox", { name: "To:" });
  await expect(to).toBeFocused();
  await page.getByRole("dialog", { name: "Agents" }).getByRole("option", { name: /Vent/ }).click();
  await expect(page.getByTestId("new-to-field")).toContainText("Vent");
  await to.press("Enter");
  await expect(page).toHaveURL(/#\/c\/dm_vent$/);
});

test("New message lists every agent, recent DMs first under Recent, and takes several agents for a Solo room", async ({ page, request }) => {
  const registered = ((await (await request.get("/api/agents")).json()) as { id: string; name: string; archived: boolean }[]).filter((a) => a.id.startsWith("ag_") && !a.archived);
  const dms = ((await (await request.get("/api/sidebar")).json()) as { dms: { agent?: string }[] }).dms.map((d) => d.agent).filter((a) => registered.some((r) => r.id === a));
  await open(page, "#/c/new?kind=dm", "main-panel");
  const list = page.getByRole("dialog", { name: "Agents" });
  await expect(list.getByRole("option")).toHaveCount(registered.length);
  if (dms.length) {
    await expect(list.locator(".group").first()).toHaveText("Recent");
    const first = registered.find((a) => a.id === dms[0])!;
    await expect(list.getByRole("option").first()).toContainText(first.name);
  }

  const to = page.getByRole("combobox", { name: "To:" });
  await to.fill("vent");
  await expect(list.locator(".group")).toHaveCount(0);
  await to.press("Enter");
  await expect(page.getByRole("button", { name: "Open DM with Vent" })).toBeVisible();
  await to.fill("frontend");
  await to.press("Enter");
  await expect(page.getByRole("button", { name: /Open DM/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "First message" })).toHaveAttribute("placeholder", "What should Vent and frontend bro settle?");
  const height = await page.getByRole("textbox", { name: "First message" }).evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(60);

  await to.press("Backspace");
  await expect(page.getByTestId("new-to-field")).not.toContainText("frontend bro");
  await expect(page.getByRole("button", { name: "Open DM with Vent" })).toBeVisible();
});

test("New channel says a taken name is taken while you type and keeps Create off", async ({ page, request }) => {
  const rooms = (await (await request.get("/api/rooms")).json()) as { kind: string; name: string; archived: boolean }[];
  const existing = rooms.find((r) => r.kind === "channel" && !r.archived)!;
  await open(page, "#/c/new?kind=channel", "main-panel");
  const create = page.getByTestId("main-panel").getByRole("button", { name: "Create channel" });
  await page.getByLabel("Name").fill(existing.name);
  await expect(page.getByText("That name is already taken by a channel.")).toBeVisible();
  await expect(create).toBeDisabled();
  await page.getByLabel("Name").fill(`${existing.name}-${tag()}`);
  await expect(page.getByText("That name is already taken by a channel.")).toHaveCount(0);
  await expect(create).toBeEnabled();
});

test("Messages with nothing open asks to pick a conversation", async ({ page }) => {
  await open(page, "#/c", "main-panel");
  await expect(page.getByText("Pick a conversation")).toBeVisible();
});

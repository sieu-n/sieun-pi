import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers";

/** A test channel of its own, so adds and removes never change the members other specs count in the fixture's channels. */
async function channel(page: Page, members: string[]): Promise<{ id: string; name: string }> {
  const res = await page.request.post("/api/rooms", { data: { kind: "channel", name: `members-${tag()}`, members, test: true } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; name: string };
}

const count = (page: Page) => page.getByTestId("channel-members");

test("the member list adds an agent from its Add people row and shows it at once", async ({ page }) => {
  const room = await channel(page, ["ag_crawler-vp"]);
  await open(page, `#/c/${room.id}`);
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
  await count(page).click();
  const list = page.getByRole("dialog", { name: `Members of #${room.name}` });
  await expect(page.getByTestId("members-add")).toBeFocused();
  await page.getByTestId("members-add").click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  await expect(picker.getByRole("option", { name: /Crawler VP/ })).toHaveCount(0);
  await picker.getByRole("searchbox").fill("front");
  await picker.getByRole("option", { name: /frontend bro/ }).click();
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 3 members");
  await expect(list.locator('[data-member="ag_frontend-bro"]')).toBeVisible();
  await expect(page.getByText(`Added frontend bro to #${room.name}`)).toBeVisible();
});

test("an agent row shows Remove on hover and keyboard focus, removes at once and Undo brings it back", async ({ page }) => {
  const room = await channel(page, ["ag_crawler-vp", "ag_frontend-bro"]);
  await open(page, `#/c/${room.id}`);
  await count(page).click();
  const list = page.getByRole("dialog", { name: `Members of #${room.name}` });
  const remove = list.getByRole("button", { name: `Remove Crawler VP from #${room.name}` });
  const shown = list.locator('[data-member="ag_crawler-vp"] .remove');
  await expect(shown).toHaveCSS("opacity", "0");
  await list.locator('[data-member="ag_crawler-vp"]').hover();
  await expect(shown).toHaveCSS("opacity", "1");
  await expect(list.locator('[data-member="owner"]').getByRole("button")).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(list.locator('[data-member="ag_crawler-vp"] .main')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
  await expect(list.locator('[data-member="ag_frontend-bro"] .main')).toBeFocused();
  await expect(page.locator("section.conversation").getByText("You removed Crawler VP")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 3 members");

  await count(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
});

test("Enter on an agent row opens its DM, and the channel menu's Add people opens the same picker", async ({ page }) => {
  const room = await channel(page, ["ag_frontend-bro"]);
  await open(page, `#/c/${room.id}`);
  await page.getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Add people" }).click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  await expect(picker.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await count(page).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\/dm_frontend-bro/);
});

test("a test channel's picker lists test agents", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: `members agent ${tag()}`, test: true } })).json()) as { id: string; name: string };
  const room = await channel(page, []);
  await open(page, `#/c/${room.id}`);
  await count(page).click();
  await page.getByTestId("members-add").click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  await picker.getByRole("option", { name: new RegExp(agent.name) }).click();
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
});

test("a test agent's Work tab adds it to a test channel from the same picker and removes it with Undo", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: `work tab agent ${tag()}`, test: true } })).json()) as { id: string; name: string };
  const room = await channel(page, []);
  await page.goto(`/#/agents/${agent.id}?section=work`);
  const rooms = page.getByRole("region", { name: "Rooms" });
  await expect(rooms).toContainText("In no channel or Solo room.");
  await page.getByTestId("add-to-channel").click();
  const picker = page.getByRole("dialog", { name: `Add ${agent.name} to a channel` });
  await expect(picker.getByRole("option", { name: /^general/ })).toHaveCount(0);
  await picker.getByRole("searchbox").fill("no such channel");
  await expect(picker).toContainText("No channel matches");
  await picker.getByRole("searchbox").fill(room.name);
  await picker.getByRole("option", { name: new RegExp(`^${room.name}`) }).click();
  const chip = rooms.getByRole("button", { name: room.name, exact: true });
  await expect(chip).toBeVisible();
  await expect(page.getByText(`Added ${agent.name} to #${room.name}`)).toBeVisible();
  await rooms.getByRole("button", { name: `Remove ${agent.name} from #${room.name}` }).click();
  await expect(chip).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`#/c/${room.id}`));
});

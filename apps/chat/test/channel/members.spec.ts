import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers";

/** A test channel of its own, so adds and removes never change the members other specs count in the fixture's channels. */
async function channel(page: Page, members: string[]): Promise<{ id: string; name: string }> {
  const res = await page.request.post("/api/rooms", { data: { kind: "channel", name: `members-${tag()}`, members, test: true } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; name: string };
}

const count = (page: Page) => page.getByTestId("channel-members");

test("Add people picks several agents, clears the search after each pick and adds them all with one Add", async ({ page }) => {
  // A test channel's picker lists only test agents, so this one picks three of its own.
  const t = tag();
  const make = async (name: string) => (await (await page.request.post("/api/agents", { data: { name: `${name} ${t}`, test: true } })).json()) as { id: string; name: string };
  const [front, vent, harness] = [await make("front pick"), await make("vent pick"), await make("harness pick")];
  const room = await channel(page, ["ag_crawler-vp"]);
  await open(page, `#/c/${room.id}`);
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
  await count(page).click();
  const list = page.getByRole("dialog", { name: `Members of #${room.name}` });
  await expect(page.getByTestId("members-add")).toBeFocused();
  await page.getByTestId("members-add").click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  const search = picker.getByRole("searchbox");
  const add = picker.getByRole("button", { name: "Add", exact: true });
  await expect(picker.getByRole("option", { name: /^(Crawler VP|frontend bro|AI harness)/ })).toHaveCount(0);
  await expect(add).toBeDisabled();
  await search.fill(`front pick ${t}`);
  await picker.getByRole("option", { name: new RegExp(front.name) }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(picker.getByRole("option", { name: new RegExp(front.name) })).toHaveAttribute("aria-selected", "true");
  await search.fill(`vent pick ${t}`);
  await page.keyboard.press("Enter");
  await expect(search).toHaveValue("");
  await expect(picker.getByRole("button", { name: `Unpick ${vent.name}` })).toBeVisible();
  await search.fill(`harness pick ${t}`);
  await page.keyboard.press("Enter");
  await picker.getByRole("button", { name: `Unpick ${harness.name}` }).click();
  await expect(search).toBeFocused();
  await expect(picker.getByRole("button", { name: /^Unpick/ })).toHaveCount(2);

  const posts: string[] = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith(`/api/rooms/${room.id}/members`) && posts.push(r.postData() ?? ""));
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 4 members");
  await expect(list.locator(`[data-member="${front.id}"]`)).toBeVisible();
  await expect(list.locator(`[data-member="${vent.id}"]`)).toBeVisible();
  await expect(page.getByText(`Added ${front.name} and ${vent.name} to #${room.name}`)).toBeVisible();
  expect(posts.map((p) => (JSON.parse(p) as { agents: string[] }).agents)).toEqual([[front.id, vent.id]]);
});

test("Mentions only switches a member to wake on mentions, marks its row and switches back", async ({ page }) => {
  const room = await channel(page, ["ag_crawler-vp", "ag_frontend-bro"]);
  await open(page, `#/c/${room.id}`);
  await count(page).click();
  const list = page.getByRole("dialog", { name: `Members of #${room.name}` });
  const row = list.locator('[data-member="ag_crawler-vp"]');
  const toggle = list.getByRole("button", { name: "Mentions only for Crawler VP" });
  await expect(row.locator(".mute")).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(row).toContainText("Mentions only");
  await page.mouse.move(0, 0);
  await expect(row.locator(".mute")).toHaveCSS("opacity", "1");
  await expect(list.locator('[data-member="ag_frontend-bro"]')).not.toContainText("Mentions only");
  await expect.poll(async () => {
    const rooms = (await (await page.request.get("/api/rooms?test=1")).json()) as { id: string; members: { principal: { id: string }; wakeOn: string }[] }[];
    return rooms.find((r) => r.id === room.id)?.members.find((m) => m.principal.id === "ag_crawler-vp")?.wakeOn;
  }).toBe("none");

  await page.reload();
  await count(page).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(row).not.toContainText("Mentions only");
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
  await expect(list.getByRole("button", { name: "Mentions only for Crawler VP" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  // The system line comes on the socket, so no read of the room's items waits behind the remove: on 11-23 that read counted as one of his
  // waits for the room 3 times in a minute (work/p278-thread-open/census.md).
  const reads: string[] = [];
  page.on("request", (r) => r.method() === "GET" && r.url().includes(`/api/c/${room.id}/items`) && reads.push(r.url()));
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
  await expect(list.locator('[data-member="ag_frontend-bro"] .main')).toBeFocused();
  await expect(page.locator("section.conversation").getByText("You removed Crawler VP")).toBeVisible();
  expect(reads).toEqual([]);
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

test("a test channel's picker lists only test agents", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: `members agent ${tag()}`, test: true } })).json()) as { id: string; name: string };
  const room = await channel(page, []);
  await open(page, `#/c/${room.id}`);
  await count(page).click();
  await page.getByTestId("members-add").click();
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  await expect(picker.getByRole("option", { name: new RegExp(agent.name) })).toBeVisible();
  await expect(picker.getByRole("option", { name: /^(Crawler VP|frontend bro|AI harness)/ })).toHaveCount(0);
  await picker.getByRole("option", { name: new RegExp(agent.name) }).click();
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await expect(count(page)).toHaveAttribute("aria-label", "Members, 2 members");
});

test("a test agent's Threads tab adds it to a test channel and a test Solo room at once, and removes each with Undo", async ({ page }) => {
  const make = async (name: string) => (await (await page.request.post("/api/agents", { data: { name: `${name} ${tag()}`, test: true } })).json()) as { id: string; name: string };
  const agent = await make("work tab agent");
  const other = await make("solo mate");
  const room = await channel(page, []);
  const solo = (await (await page.request.post("/api/rooms", { data: { kind: "solo", agenda: `work tab solo ${tag()}`, members: [other.id], test: true } })).json()) as { id: string; name: string };
  await page.goto(`/#/agents/${agent.id}?section=threads`);
  const rooms = page.getByRole("region", { name: "Rooms" });
  await expect(rooms).toContainText("In no channel or Solo room.");
  await page.getByTestId("add-to-channel").click();
  const picker = page.getByRole("dialog", { name: `Add ${agent.name} to a channel or Solo room` });
  await expect(picker.getByRole("option", { name: /^general/ })).toHaveCount(0);
  await picker.getByRole("searchbox").fill("no such room");
  await expect(picker).toContainText("No channel or Solo room matches");
  await picker.getByRole("searchbox").fill(room.name);
  await picker.getByRole("option", { name: new RegExp(`^${room.name}`) }).click();
  await picker.getByRole("searchbox").fill(solo.name);
  await expect(picker.getByRole("option", { name: new RegExp(`^${solo.name}`) })).toContainText(other.name);
  await picker.getByRole("option", { name: new RegExp(`^${solo.name}`) }).click();
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  const chip = rooms.getByRole("button", { name: room.name, exact: true });
  const soloChip = rooms.getByRole("button", { name: solo.name, exact: true });
  await expect(chip).toBeVisible();
  await expect(soloChip).toBeVisible();
  await expect(page.getByText(`Added ${agent.name} to #${room.name} and ${solo.name}`)).toBeVisible();

  await rooms.getByRole("button", { name: `Remove ${agent.name} from ${solo.name}` }).click();
  await expect(soloChip).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(soloChip).toBeVisible();
  // Undo brings a mentions-only member back as mentions only, also when the page shows the answer it kept from before the change: the
  // reload's first read of the config waits until the remove went out, as a slow read does (release-d38fdb7 at load 90, 11-23).
  expect((await page.request.patch(`/api/rooms/${room.id}/members/${agent.id}`, { data: { wakeOn: "none" } })).ok()).toBe(true);
  let removeSent!: () => void;
  const removing = new Promise<void>((resolve) => (removeSent = resolve));
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes(`/api/rooms/${room.id}/members/`)) removeSent();
  });
  let held = false;
  await page.route(`**/api/agents/${agent.id}/config`, async (route) => {
    if (!held) {
      held = true;
      await removing;
    }
    await route.continue();
  });
  await page.reload();
  await rooms.getByRole("button", { name: `Remove ${agent.name} from #${room.name}` }).click();
  await expect(chip).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(chip).toBeVisible();
  await expect.poll(async () => {
    const all = (await (await page.request.get("/api/rooms?test=1")).json()) as { id: string; members: { principal: { id: string }; wakeOn: string }[] }[];
    return all.find((r) => r.id === room.id)?.members.find((m) => m.principal.id === agent.id)?.wakeOn;
  }).toBe("none");
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`#/c/${room.id}`));
});

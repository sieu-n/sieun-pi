import { expect, test } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/** Slack's Forward message on a post's hover bar, and the quote card the forward draws in the room it went to, in a fixture channel and DM. */
const ROOM = "ch_cutover";
// On 11-03 at a box load of 326 the post specs took 18 to 33 s each against the 30 s default, while the fixture agents streamed their replies.
test.describe.configure({ timeout: 60_000 });

async function post(request: import("@playwright/test").APIRequestContext, text: string, room = ROOM): Promise<string> {
  const response = await request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } });
  return ((await response.json()) as { item: { id: string } }).item.id;
}

test("the owner forwards a channel post into a DM with a note, and the DM shows it as a quote card with View message", async ({ page, request }) => {
  const word = tag();
  const id = await post(request, `relay is up ${word}`);
  await open(page, `#/c/${ROOM}`);
  const source = row(page, id);
  const dialog = page.locator("[data-forward-dialog]");
  await expect(async () => {
    if (await dialog.isVisible()) return;
    await page.keyboard.press("Escape");
    await source.hover();
    await source.locator("[data-forward-message]").click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Forward this message" })).toBeVisible();
  await expect(dialog.locator("[data-forward]")).toContainText(`relay is up ${word}`);

  const send = page.locator("[data-forward-send]");
  await expect(send).toBeDisabled();
  const to = page.getByRole("combobox", { name: "To:" });
  await to.fill("vent");
  await to.press("Enter");
  await expect(dialog.getByRole("button", { name: "Remove Vent" })).toBeVisible();
  const note = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(note).toBeFocused();
  await note.fill(`see this ${word}`);
  await note.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Message forwarded to Vent")).toBeVisible();

  await page.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/#\/c\/dm_vent/);
  const card = page.locator(`[data-forward="${ROOM}:${id}"]`).last();
  await expect(card).toContainText(`relay is up ${word}`);
  await expect(card).toContainText("Posted in #pi-cutover");
  await expect(page.getByText(`see this ${word}`, { exact: true })).toBeVisible();
  await card.locator("[data-forward-view]").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${ROOM}\\?m=${id}`));
});

test("a post forwards into its own room when the sidebar does not list it, such as a test channel", async ({ page, request }) => {
  const word = tag();
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `fwd-${word}`, agenda: "forward", members: [], test: true } })).json()) as { id: string; name: string };
  const id = await post(request, `keep this ${word}`, room.id);
  await open(page, `#/c/${room.id}`);
  const source = row(page, id);
  const dialog = page.locator("[data-forward-dialog]");
  await expect(async () => {
    if (await dialog.isVisible()) return;
    await page.keyboard.press("Escape");
    await source.hover();
    await source.locator("[data-forward-message]").click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  const to = page.getByRole("combobox", { name: "To:" });
  await to.fill(room.name);
  await expect(page.getByRole("option", { name: room.name })).toBeVisible();
  await to.press("Enter");
  await expect(dialog.getByRole("button", { name: `Remove ${room.name}` })).toBeVisible();
  await page.locator("[data-forward-send]").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`main [data-forward="${room.id}:${id}"]`)).toBeVisible();
  await request.patch(`/api/rooms/${room.id}`, { data: { archived: true } });
});

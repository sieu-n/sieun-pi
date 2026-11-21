import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

/** Channel details (ChannelDetailsDialog): the channel name opens it, the description edits in place, and an archived channel reads only. */
async function channel(page: Page, purpose = "", test = true): Promise<{ id: string; name: string }> {
  const res = await page.request.post("/api/rooms", { data: { kind: "channel", name: `details-${tag()}`, agenda: purpose, members: [], test } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; name: string };
}

const details = (page: Page, name: string) => page.getByRole("dialog", { name: `#${name}` });

test("the channel name opens details, whose description saves on Enter and drops on Esc", async ({ page }) => {
  const room = await channel(page);
  await open(page, `#/c/${room.id}`);
  await expect(conversation(page).getByTestId("channel-purpose")).toHaveText("Add a description");
  await expect(page.getByTestId("channel-intro").getByRole("button", { name: "Add description" })).toBeVisible();

  await conversation(page).getByTestId("channel-title-button").click();
  const dialog = details(page, room.name);
  await expect(dialog.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toContainText(`#${room.name}`);
  await expect(dialog).toContainText("1 member");
  await expect(dialog).toContainText("You made this channel on");
  await expect(dialog).toContainText(room.id);

  await dialog.getByRole("button", { name: "Add a description" }).click();
  const field = dialog.getByRole("textbox", { name: "Description" });
  await expect(field).toBeFocused();
  await field.fill("throwaway words");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Add a description" }).click();
  await dialog.getByRole("textbox", { name: "Description" }).fill("Plans the walk");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Channel description updated")).toBeVisible();
  await expect(dialog.getByTestId("details-description")).toContainText("Plans the walk");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(conversation(page).getByTestId("channel-purpose")).toHaveText("Plans the walk");

  await conversation(page).getByTestId("channel-purpose").click();
  await expect(details(page, room.name).getByRole("textbox", { name: "Description" })).toHaveValue("Plans the walk");
});

test("Settings archives the channel with Undo, and the archived channel opens read-only with Unarchive", async ({ page }) => {
  // The Archived channels list leaves a walk's test rooms out, so this channel is a plain fixture one.
  const room = await channel(page, "Short lived", false);
  await open(page, `#/c/${room.id}`);
  await conversation(page).getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Channel details" }).click();
  const dialog = details(page, room.name);
  await dialog.getByRole("tab", { name: "Settings" }).click();
  await dialog.getByRole("button", { name: "Archive" }).click();
  await expect(page).not.toHaveURL(new RegExp(room.id));
  await expect(page.getByText(`Archived #${room.name}`)).toBeVisible();

  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "Channels options" }).click();
  await page.getByRole("menuitem", { name: "Archived channels" }).click();
  const picker = page.getByRole("dialog", { name: "Archived channels" });
  await picker.getByRole("searchbox").fill(room.name);
  await picker.getByRole("option", { name: new RegExp(room.name) }).click();
  await expect(page).toHaveURL(new RegExp(room.id));

  const banner = page.getByTestId("archived-banner");
  await expect(banner).toContainText(`#${room.name}, an archived channel`);
  await expect(composerInput(conversation(page))).toHaveCount(0);
  await banner.getByRole("button", { name: "Unarchive" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText(`Unarchived #${room.name}`)).toBeVisible();
  await page.request.patch(`/api/rooms/${room.id}`, { data: { archived: true } });
});

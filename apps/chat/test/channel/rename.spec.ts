import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

/** Channel rename from the header menu (RenameChannelDialog): the header, sidebar row and # typeahead follow, and the id link keeps working. */
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

async function renameFromHeader(page: Page, to: string) {
  await conversation(page).getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Rename channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename channel" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox", { name: "Name" });
  await field.fill(to);
  return dialog;
}

test("a channel renamed from its header menu shows the new name everywhere, keeps its link and refuses a taken name", async ({ page, request }) => {
  const word = tag();
  const created = await request.post("/api/rooms", { data: { kind: "channel", name: `ren-${word}` } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const before = `ren-${word}`;
  const after = `renamed-${word}`;

  await open(page, `#/c/${id}`);
  await expect(conversation(page).getByTestId("conversation-title")).toHaveText(before);

  await conversation(page).getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "Rename channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename channel" });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue(before);
  const submit = dialog.getByRole("button", { name: "Rename", exact: true });
  await expect(submit).toBeDisabled();
  await field.fill("  ");
  await expect(submit).toBeDisabled();
  await field.fill(`Renamed ${word}`);
  await expect(field).toHaveValue(after);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Renamed to #${after}`)).toBeVisible();

  await expect(conversation(page).getByTestId("conversation-title")).toHaveText(after);
  await expect(sidebar(page).locator(`a[href="#/c/${id}"]`)).toContainText(after);
  await expect(sidebar(page).getByRole("link", { name: before, exact: true })).toHaveCount(0);

  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`see #renamed-${word}`);
  await page.getByRole("option", { name: new RegExp(after) }).click();
  await expect(input.locator("[data-chip-kind=channel]")).toHaveText(`#${after}`);
  await input.fill("");
  await page.keyboard.type(`see #ren-${word}`);
  await expect(page.getByRole("option", { name: new RegExp(`^#?${before}`) })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/#/c/dm_vent");
  await open(page, `#/c/${id}`);
  await expect(conversation(page).getByTestId("conversation-title")).toHaveText(after);

  const taken = await renameFromHeader(page, "general");
  await taken.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(taken.getByRole("alert")).toContainText("#general already exists");
  await expect(taken).toBeVisible();
  await taken.getByRole("button", { name: "Cancel" }).click();
  await expect(taken).toHaveCount(0);
  await expect(conversation(page).getByTestId("conversation-title")).toHaveText(after);

  const back = await renameFromHeader(page, before);
  await back.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(back).toHaveCount(0);
  await expect(conversation(page).getByTestId("conversation-title")).toHaveText(before);
  await expect(sidebar(page).locator(`a[href="#/c/${id}"]`)).toContainText(before);
});

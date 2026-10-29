import { expect, test } from "@playwright/test";
import { card, newAgentButton, openAgents, uniqueName } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

test("Create agent asks for a name, makes the agent and opens its DM", async ({ page, request }) => {
  await openAgents(page);
  await newAgentButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(dialog.getByText("Add a name to create your agent")).toBeVisible();

  const name = uniqueName("spec agent");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/c\/dm_[^/?]+$/);
  const room = decodeURIComponent(page.url().split("#/c/")[1]!);

  const created = ((await (await request.get("/api/agents")).json()) as { id: string; room?: string; name: string; kind: string; model: { label: string } | null }[]).find((agent) => agent.room === room);
  const id = created!.id;
  expect(id).toBe(`ag_${room.slice(3)}`);
  expect(created?.name).toBe(name);
  expect(created?.kind).toBe("chat");

  await openAgents(page);
  const cell = card(page, { id });
  await expect(cell).toContainText(name);
  await expect(cell).toContainText(created!.model!.label);

  await cell.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText(`Archived ${name}`)).toBeVisible();
  await expect(cell).toHaveCount(0);
});

test("Change model in the card menu opens the picker and saves the new model", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()) as { models: { provider: string; id: string; label: string }[] };
  test.skip(models.models.length < 2, "needs two models");
  const created = (await (await request.post("/api/agents", { data: { name: uniqueName("spec model") } })).json()) as { id: string; name: string; model: { id: string } };
  try {
    await openAgents(page);
    const cell = card(page, created);
    await cell.getByRole("button", { name: `Actions for ${created.name}` }).click();
    await page.getByRole("menuitem", { name: "Change model" }).click();
    const other = models.models.find((model) => model.id !== created.model.id)!;
    await page.getByRole("option", { name: other.label }).click();
    await expect(page.getByText(`${created.name} now runs ${other.label}`)).toBeVisible();
    await expect(cell).toContainText(other.label);
    const after = ((await (await request.get("/api/agents")).json()) as { id: string; model: { id: string } }[]).find((agent) => agent.id === created.id);
    expect(after?.model.id).toBe(other.id);
  } finally {
    await request.patch(`/api/c/${encodeURIComponent(created.id)}`, { data: { archived: true } });
  }
});

test("the dialog closes on Esc or an outside click only while untouched", async ({ page }) => {
  await openAgents(page);
  await newAgentButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await page.mouse.click(30, 880);
  await expect(dialog).toHaveCount(0);
  await newAgentButton(page).click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("half typed");
  await page.mouse.click(30, 880);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

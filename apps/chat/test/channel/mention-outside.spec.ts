import { expect, test } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

/** #pi-cutover's members are the AI harness VP, Crawler VP and frontend bro; Vent is not one (server/fixture/seed.ts). */
const CHANNEL = "ch_cutover";

test("the @ card lists an agent outside the channel last, marked not in the channel, and its mention goes out without a join", async ({ page, request }) => {
  await open(page, `#/c/${CHANNEL}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("@");
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const vent = page.getByRole("option", { name: /^Vent/ });
  await expect(vent).toContainText("not in #pi-cutover");
  await expect(page.getByRole("option", { name: /^Crawler VP/ })).not.toContainText("not in");
  const names = await options.evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label") ?? row.textContent ?? ""));
  const at = (name: string) => names.findIndex((n) => n.includes(name));
  expect(at("Crawler VP"), names.join(" | ")).toBeGreaterThanOrEqual(0);
  expect(at("Vent"), names.join(" | ")).toBeGreaterThan(at("Crawler VP"));

  await page.keyboard.type("ven");
  await page.keyboard.press("Enter");
  await expect(input.locator("[data-chip-id]")).toHaveText("@Vent");
  const word = tag();
  await page.keyboard.type(`quiet ${word}`);
  const sent = page.waitForResponse((r) => r.url().includes(`/api/c/${CHANNEL}/send`) && r.request().method() === "POST");
  await page.keyboard.press("Enter");
  const body = (await (await sent).json()) as { deliveries: { name: string }[] };
  expect(body.deliveries.map((d) => d.name)).toContain("Vent");
  const room = ((await (await request.get("/api/rooms")).json()) as { id: string; members: { principal: { name: string } }[] }[]).find((r) => r.id === CHANNEL)!;
  expect(room.members.map((m) => m.principal.name)).not.toContain("Vent");
});

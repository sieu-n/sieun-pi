import { expect, test } from "@playwright/test";
import { open, row } from "./helpers";

type Body = { items: { id: string; mentions: string[]; deliveries?: unknown[] }[] };
const queued = (target: string, name: string) => ({ target, name, state: "queued", at: 0 });

test("the line under a waiting post says mentioned only for an agent the post names, and why for each other agent", async ({ page }) => {
  // The fixture's deliveries settle at once, so the page reads them as still waiting for a slot.
  await page.route("**/api/c/ch_cutover/items*", async (route) => {
    const body = (await (await route.fetch()).json()) as Body;
    for (const item of body.items) if (item.id === "p7") Object.assign(item, { mentions: ["ag_frontend-bro"], deliveries: [queued("ag_frontend-bro", "frontend bro"), queued("ag_crawler-vp", "Crawler VP")] });
    await route.fulfill({ json: body });
  });
  await page.route("**/api/c/ch_cutover/replies/p1*", async (route) => {
    const body = (await (await route.fetch()).json()) as Body;
    const reply = body.items[0]!;
    Object.assign(reply, { mentions: ["ag_vent"], deliveries: [queued("ag_vent", "Vent"), queued("ag_crawler-vp", "Crawler VP")] });
    await route.fulfill({ json: body });
  });
  await open(page, "#/c/ch_cutover");
  const root = row(page, "p7");
  await expect(root).toContainText("frontend bro was mentioned and waits for a working slot.");
  await expect(root).toContainText("Crawler VP is a member and waits for a working slot.");
  await expect(root).not.toContainText("Crawler VP was mentioned");

  await row(page, "p1").locator("[data-thread-pill]").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toContainText("Vent was mentioned and waits for a working slot.");
  await expect(pane).toContainText("Crawler VP is in this thread and waits for a working slot.");
  await expect(pane).not.toContainText("Crawler VP was mentioned");
});

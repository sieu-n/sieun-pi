import { HARNESS, HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

/**
 * A duty is edited, removed with Undo, added and read run by run from the board's Duties card, and the agent page runs the same list.
 * Run: cd apps/chat && CHAT_SERVER_URL=http://127.0.0.1:5944 CHAT_WEB_PORT=5945 npx playwright test test/board/duties.spec.ts
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

const dutiesOf = async (request: import("@playwright/test").APIRequestContext, chatServer: string) =>
  (await (await request.get(`${chatServer}/api/agents/${HARNESS_AGENT}/duties`)).json()).duties as { duty: { id: string; goal: string }; schedule: unknown }[];

test("a duty's goal and schedule change from its More menu, and the server keeps them", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await expect(duties).toContainText("Daily at 07:40", { timeout: 30_000 });
  await duties.getByRole("button", { name: "More actions for Relay uptime" }).click();
  await page.getByRole("menuitem", { name: "Edit goal and schedule…" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Relay uptime" });
  await dialog.getByLabel("Goal").fill("The canary relay answers every 30 s.");
  await dialog.getByLabel("Repeat").selectOption("every");
  await dialog.getByLabel("Minutes between runs").fill("30");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(duties).toContainText("Every 30 min");
  const d1 = (await dutiesOf(request, chatServer)).find(row => row.duty.id === "d1")!;
  expect(d1.duty.goal).toBe("The canary relay answers every 30 s.");
  expect(d1.schedule).toEqual({ kind: "every", minutes: 30 });
  await request.post(`${chatServer}/api/agents/${HARNESS_AGENT}/duties`, { data: { action: "goal", duty: "d1", goal: "The canary relay answers every minute." } });
  await request.post(`${chatServer}/api/agents/${HARNESS_AGENT}/duties`, { data: { action: "schedule", duty: "d1", schedule: { kind: "daily", at: "07:40" } } });
});

test("Remove hides a duty with Undo, Undo brings it back, and a remove left alone deletes it on the server", async ({ page, request, chatServer }) => {
  const probe = { name: "Probe check", ownerWords: "watch the probe", goal: "The probe answers.", onMiss: "Fix the probe.", metrics: [{ key: "up", label: "Up", op: ">=", target: 1 }],
    precheck: { command: ["node", "-e", "0"], cwd: "/tmp" } };
  // A removed duty's id is never given again (boards.ts `dutyIdFloor`), so a second run of this test on the worker's server adds d4, not d3.
  const added = await (await request.post(`${chatServer}/api/agents/${HARNESS_AGENT}/duties`, { data: { action: "set", duty: probe } })).json() as { result: string };
  expect(added.result).toMatch(/^added d\d+$/);
  const id = added.result.replace(/^added /, "");
  // The page's clock runs the Undo wait, so the 6 s window costs no real time and a slow box cannot run the test past its budget.
  await page.clock.install();
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await duties.getByRole("button", { name: "More actions for Probe check" }).click();
  await page.getByRole("menuitem", { name: "Remove duty" }).click();
  await expect(duties).not.toContainText("Probe check");
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).click();
  await expect(duties).toContainText("Probe check");
  await page.clock.runFor(6500);
  expect((await dutiesOf(request, chatServer)).map(row => row.duty.id)).toEqual(["d1", "d2", id]);

  await duties.getByRole("button", { name: "More actions for Probe check" }).click();
  await page.getByRole("menuitem", { name: "Remove duty" }).click();
  await expect(duties).not.toContainText("Probe check");
  await page.clock.runFor(6500);
  await expect.poll(async () => (await dutiesOf(request, chatServer)).map(row => row.duty.id), { timeout: 10_000 }).toEqual(["d1", "d2"]);
  await expect(duties).not.toContainText("Probe check");
});

test("a run row opens to its measure and its job, and the duty's job is a link", async ({ page }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await duties.getByRole("button", { name: /Relay uptime/ }).first().click();
  const missed = duties.locator(".run-row", { hasText: "97.2" });
  await missed.click();
  const detail = duties.locator("[data-run-detail]");
  await expect(detail).toContainText("on its schedule");
  await expect(detail).toContainText("Relay uptime: 97.2%, target >= 99%");
  await expect(detail.getByRole("link")).toHaveAttribute("href", /#\/agents\//);
});

test("an open duty with a long unbroken goal path and a long run summary stays inside the Duties card", async ({ page }) => {
  // The live d2 card widened past the board on 11-23: a one-line run summary set the width of the open card's grids.
  const path = `~/work/${"sw_factory_fixes/".repeat(12)}duty_goal_with_a_long_unbroken_path.log`;
  const summary = Array.from({ length: 40 }, (_, i) => `slowest_api_p90_ms ${1800 + i} ms (target at most 1000 ms)`).join(", ");
  // An open panel reads again over the live socket when the socket opens after its HTTP read left (kept.svelte.ts `missed`), and a duty event
  // carries the server's rows too, so under load the card showed the seed goal past this route. With no socket the made-up rows are all it gets.
  await page.routeWebSocket(/\/api\/live/, () => {});
  await page.route(/\/api\/(agents|threads)\/[^/]+\/duties$/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.duties ?? []) {
      if (row.duty.id !== "d1") continue;
      row.duty.goal = `The relay log at ${path} stays clean.`;
      if (row.runs[0]) row.runs[0].summary = summary;
    }
    await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await duties.getByRole("button", { name: /Relay uptime/ }).first().click();
  const goal = duties.locator(".goal");
  await expect(goal).toContainText(path);
  const [region, card, text] = await Promise.all([duties.boundingBox(), duties.locator("li.duty").first().boundingBox(), goal.boundingBox()]);
  expect(card!.x + card!.width).toBeLessThanOrEqual(region!.x + region!.width + 1);
  expect(text!.x + text!.width).toBeLessThanOrEqual(region!.x + region!.width + 1);
  expect(await goal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("Add duty sends the owner's words and schedule to the agent's DM", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${HARNESS}`);
  const duties = page.getByRole("region", { name: "Duties" });
  await duties.getByRole("button", { name: "Add duty" }).click();
  const dialog = page.getByRole("dialog", { name: "New duty" });
  await dialog.getByLabel("What should it check?").fill("every channel answers within 5 minutes");
  await dialog.getByLabel("Repeat").selectOption("daily");
  await dialog.getByLabel("Time of day").fill("08:15");
  await dialog.getByRole("button", { name: "Send to agent" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("The duty shows here once it adds it.");
  const room = `dm_${HARNESS_AGENT.slice(3)}`;
  const items = await (await request.get(`${chatServer}/api/c/${room}/items`)).json();
  expect(JSON.stringify(items)).toContain("Please add a duty for this: every channel answers within 5 minutes\\n\\nRun it daily at 08:15.");
});

test("the agent page's Duties section runs, pauses and edits the same list", async ({ page }) => {
  await page.goto(`/#/agents/${HARNESS_AGENT}?section=jobs`);
  const duties = page.getByRole("region", { name: "Duties" });
  await expect(duties.getByRole("button", { name: "Run Relay uptime now" })).toBeVisible();
  await duties.getByRole("switch", { name: "Relay uptime on" }).click();
  await expect(duties.getByRole("switch", { name: "Relay uptime on" })).not.toBeChecked();
  await expect(duties.getByRole("button", { name: "Add duty" })).toBeVisible();
});

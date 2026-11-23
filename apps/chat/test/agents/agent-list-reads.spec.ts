import { expect, test, type Page } from "@playwright/test";
import { agentPage, uniqueName } from "./helpers.ts";

/**
 * GET /api/agents from the Agents page and a test room's member picker. In the p155 sweep at a 200 ms round trip on 11-23, each rename on
 * an agent's page read the agent list twice at once, the second answer a round trip later, and each member picker refresh differed from
 * the kept list only in the fields of the agent the walk had just added or removed, so it counted as his wait from the picker's open:
 * 1,601 to 1,930 ms (~/work/p155-sweep/fix-agents-list/notes.md).
 */

type Sample = { m: string; p: string; ms: number; bg?: string };

/** The page's timing lines, read from each POST /api/timings body in a route (composer.spec.ts `timingSamples`). */
function timingSamples(page: Page): Sample[] {
  const samples: Sample[] = [];
  void page.route(/\/api\/timings$/, async (route) => {
    const body = route.request().postDataBuffer();
    if (route.request().method() === "POST" && body) samples.push(...((JSON.parse(body.toString()) as { samples?: Sample[] }).samples ?? []));
    await route.continue().catch(() => undefined);
  });
  return samples;
}

test("a rename on an agent's page reads the agent list once", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { name: uniqueName("spec list reads") } })).json()) as { id: string; name: string };
  await page.goto(`/#/agents/${agent.id}`);
  const header = agentPage(page).getByRole("heading", { level: 1 });
  await expect(header).toHaveText(agent.name, { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  const lists: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname === "/api/agents") lists.push(url.search);
  });
  await header.dblclick();
  const dialog = page.getByRole("dialog", { name: "Rename agent" });
  const renamed = uniqueName("Spec List Renamed");
  await dialog.getByRole("textbox").fill(renamed);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(header).toHaveText(renamed);
  await expect.poll(() => lists.length).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  expect(lists).toEqual(["?archived=1"]);
  await request.patch(`/api/c/dm_${agent.id.slice(3)}`, { data: { archived: true } });
});

test("a test room's member picker refresh that changed only fields it does not show counts as no wait", async ({ page }) => {
  test.setTimeout(45_000);
  const t = Math.random().toString(36).slice(2, 8);
  const agent = (await (await page.request.post("/api/agents", { data: { name: `list pick ${t}`, test: true } })).json()) as { id: string; name: string };
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `list-reads-${t}`, members: [], test: true } })).json()) as { id: string; name: string };
  // Every answer is the first one with the rooms and time an add or remove changes, so other specs' new test agents change nothing here.
  let first: Record<string, unknown>[] | undefined;
  let reads = 0;
  await page.route(/\/api\/agents\?test=1$/, async (route) => {
    first ??= (await (await route.fetch()).json()) as Record<string, unknown>[];
    reads += 1;
    const n = reads;
    await route.fulfill({ json: first.map((a) => (a.id === agent.id ? { ...a, rooms: n > 1 ? [room.id] : [], updatedAt: Date.now() } : a)) });
  });
  const samples = timingSamples(page);
  await page.goto(`/#/c/${room.id}`);
  await page.getByTestId("timeline").first().waitFor({ timeout: 15_000 });
  const picker = page.getByRole("dialog", { name: `Add people to #${room.name}` });
  const openPicker = async () => {
    if (!(await page.getByTestId("members-add").isVisible())) await page.getByTestId("channel-members").click();
    await page.getByTestId("members-add").click();
    await picker.getByRole("searchbox").fill(agent.name);
    await expect(picker.getByRole("option", { name: new RegExp(agent.name) })).toBeVisible();
  };
  await openPicker();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await openPicker();
  await expect.poll(() => reads).toBe(2);
  await expect.poll(() => samples.filter((s) => s.p === "/api/agents").length, { timeout: 25_000 }).toBe(2);
  const [opened, refreshed] = samples.filter((s) => s.p === "/api/agents");
  expect(opened!.bg).toBeUndefined();
  expect(refreshed!.bg).toBe("shown");
});

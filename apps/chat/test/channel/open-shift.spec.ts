import { expect, test } from "@playwright/test";
import { tag } from "./helpers";

/**
 * A channel whose days hold one post each, as #dev-search-general does, opens without its rows jumping. On 11-24 content-visibility covered
 * every row on screen but the newest, and those rows moved from a 160 px guess to their real height after the first paint (CLS 0.11).
 * The rows on screen at open draw at once (Timeline.svelte `.eager`), and rows above them keep the speed rule.
 */
test.describe.configure({ timeout: 90_000 });

const LINES = ["Checked the census export against this morning's run.", "Lane 2 is green again after the proxy pool change.", "The search page still shows the old build for me.", "Staging is through, every row lines up."];
const DAY = 86_400_000;

test("a channel with one post a day opens with every row on screen drawn and no layout shift", async ({ page }) => {
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `shift-${tag()}`, members: [], test: true } })).json()) as { id: string };
  const roots: string[] = [];
  for (let n = 0; n < 14; n++) {
    const text = `quiet post ${n}\n\n${Array.from({ length: 1 + (n % 5) }, (_, i) => LINES[(n + i) % LINES.length]).join("\n\n")}`;
    roots.push(((await (await page.request.post(`/api/c/${room.id}/send`, { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id);
  }
  const now = Date.now();
  // The live hello would hand the rows over before this read, so the page reads them here, each post moved to its own day.
  await page.route("**/api/live**", (route) => route.abort());
  await page.route(`**/api/c/${room.id}/items**`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: { id: string; at: number }[] };
    for (const item of body.items) {
      const index = roots.indexOf(item.id);
      if (index >= 0) item.at = now - (roots.length - 1 - index) * DAY;
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.addInitScript(() => {
    const shift = { cls: 0 };
    (window as unknown as { __shift: typeof shift }).__shift = shift;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) shift.cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`/#/c/${room.id}`);
  await expect(page.locator(`section.conversation [data-message-id="${roots.at(-1)}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("section.conversation .day-group")).toHaveCount(14);
  await page.waitForTimeout(2000);
  const onScreen = await page.evaluate(() => [...document.querySelectorAll("section.conversation .day-rows > li")]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
    .map((el) => getComputedStyle(el).contentVisibility));
  expect(onScreen.length).toBeGreaterThan(2);
  expect(onScreen.every((value) => value === "visible")).toBe(true);
  const cls = await page.evaluate(() => (window as unknown as { __shift: { cls: number } }).__shift.cls);
  console.log(`open-shift CLS ${cls.toFixed(4)}`);
  expect(cls).toBeLessThan(0.02);
});

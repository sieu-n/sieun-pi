import { HARNESS_AGENT, expect, resetFixture, test } from "./helpers";

/**
 * A duties event carries the chat's whole duty rows, newer than a read of them that left before it. The page used to set the event's rows and
 * then let that read's older answer replace them, so the card showed the old rows until the next open, whose refresh changed it and counted
 * as a wait: 1,214 ms for agent factory's duties in the p155 sweep on 11-23 (~/work/p155-sweep/fix-duties/notes.md).
 * Run: cd apps/chat && CHAT_SERVER_URL=http://127.0.0.1:5944 CHAT_WEB_PORT=5945 npx playwright test test/board/duties-event-in-flight.spec.ts
 */
test.beforeEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });
test.afterEach(async ({ request, chatServer }) => { await resetFixture(request, chatServer); });

const DUTIES = `/api/agents/${HARNESS_AGENT}/duties`;

test("a duties event that comes while a read of the duties is on its way stays on the card after that read answers", async ({ page, request, chatServer }) => {
  await page.goto(`/#/board/${HARNESS_AGENT}`);
  const toggle = page.getByRole("region", { name: "Duties" }).getByRole("switch", { name: "Relay uptime on" });
  await expect(toggle).toBeChecked({ timeout: 30_000 });
  await page.evaluate(() => { location.hash = "#/agents"; });
  await expect(page.getByRole("region", { name: "Duties" })).toBeHidden();

  // The next read of the duties gets the rows as they are now, and its answer is held until the pause's event reached the page.
  let release!: () => void;
  const held = new Promise<void>(resolve => (release = resolve));
  let answered!: () => void;
  const done = new Promise<void>(resolve => (answered = resolve));
  let asked = false;
  await page.route(url => url.pathname === DUTIES, async route => {
    if (route.request().method() !== "GET" || asked) return route.fallback();
    asked = true;
    const before = await route.fetch({ url: chatServer + DUTIES });
    const body = await before.text();
    await held;
    await route.fulfill({ status: before.status(), headers: before.headers(), body });
    answered();
  });
  await page.evaluate(hash => { location.hash = hash; }, `#/board/${HARNESS_AGENT}`);
  await expect.poll(() => asked).toBe(true);

  await request.post(`${chatServer}${DUTIES}`, { data: { duty: "d1", action: "pause" } });
  await expect(toggle).not.toBeChecked();
  release();
  await done;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  await expect(toggle).not.toBeChecked();
});

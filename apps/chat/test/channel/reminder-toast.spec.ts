import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers.ts";

/**
 * A due reminder as Slack's Slackbot message has it: the toast carries View, Mark complete and a Snooze menu (lib/remind-live.ts). Undo
 * after Remove from Saved puts the row back with its reminder (server/later.ts `restore`), and a post kept unread reads as coming back
 * unread, never as a reminder he set. Each run makes its own test channel on the fixture server. The server sends a test room's due
 * reminder only to the pages that have that room open (server/app.ts `later_due`), so the toasts of one test never land on another
 * test's page, where four due reminders at once pushed out a "Removed from Saved" toast before its Undo was clicked. The pages open
 * with `?test=1`, as a walk does, so Saved reads keep the test room's rows.
 */
type Sent = { room: string; id: string; text: string };
async function posts(page: Page, count: number): Promise<Sent[]> {
  const name = `remind-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string }).id;
  const sent = [];
  for (let i = 1; i <= count; i++) {
    const text = `remind me about ${name} ${i}`;
    const res = (await (await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
    sent.push({ room, id: res.item.id, text });
  }
  return sent;
}
// posts() sends exactly `count` posts, so these indexes are always there.
const post = async (page: Page): Promise<Sent> => (await posts(page, 1))[0]!;
const twoPosts = async (page: Page): Promise<[Sent, Sent]> => {
  const sent = await posts(page, 2);
  return [sent[0]!, sent[1]!];
};

type Item = { id: string; state: string; remindAt?: number; unread?: boolean };
const item = async (page: Page, id: string): Promise<Item | undefined> =>
  ((await (await page.request.get("/api/later?test=1")).json()) as { items: Item[] }).items.find((i) => i.id === id);

test("a due reminder's toast snoozes it from a menu and marks it complete", async ({ page }) => {
  const [a, b] = await twoPosts(page);
  await open(page, `#/c/${a.room}?test=1`);
  const due = Date.now() + 1500;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt: due } });
  await page.request.post("/api/later", { data: { room: b.room, post: b.id, remindAt: due } });

  const toastA = page.locator(".toast").filter({ hasText: a.text });
  await expect(toastA).toBeVisible({ timeout: 10_000 });
  await expect(toastA.getByRole("button")).toHaveText(["View", "Mark complete", "Snooze", ""]);
  await toastA.getByRole("button", { name: "Snooze" }).click();
  const menu = page.getByRole("menu", { name: "Snooze" });
  await expect(menu.getByRole("menuitem")).toHaveText(["In 20 minutes", "In 1 hour", "In 3 hours", "Tomorrow", "Next week"]);
  const before = Date.now();
  await menu.getByRole("menuitem", { name: "In 1 hour" }).click();
  await expect(toastA).toHaveCount(0);
  // From 23:00 the hour ahead is past midnight and the toast says "tomorrow at 12:15 AM" (lib/remind.ts whenPhrase), so the spec
  // reads the toast, then checks its words against the day and time of the remindAt the server stored.
  const snoozed = page.locator(".toast").filter({ hasText: "We'll remind you" });
  await expect(snoozed).toBeVisible();
  const said = await snoozed.textContent();
  await expect.poll(async () => ((await item(page, `${a.room}:${a.id}`))?.remindAt ?? 0) - before).toBeGreaterThan(3_500_000);
  const at = (await item(page, `${a.room}:${a.id}`))!.remindAt!;
  const expected = await page.evaluate(({ at, before }) => {
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(at);
    return new Date(at).toDateString() === new Date(before).toDateString() ? `We'll remind you at ${time}` : `We'll remind you tomorrow at ${time}`;
  }, { at, before });
  expect(said).toContain(expected);

  const toastB = page.locator(".toast").filter({ hasText: b.text });
  await toastB.getByRole("button", { name: "Mark complete" }).click();
  await expect(toastB).toHaveCount(0);
  await expect(page.locator(".toast").filter({ hasText: "Marked complete" })).toBeVisible();
  await expect.poll(async () => (await item(page, `${b.room}:${b.id}`))?.state).toBe("done");
});

test("a due reminder's toast shows its memo, and goes away when another tab or the Mac app checks it off or snoozes it", async ({ page }) => {
  const [a, b] = await twoPosts(page);
  await open(page, `#/c/${a.room}?test=1`);
  const due = Date.now() + 1500;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt: due, memo: "bring the invoice" } });
  await page.request.post("/api/later", { data: { room: b.room, post: b.id, remindAt: due } });
  const toastA = page.locator(".toast").filter({ hasText: a.text });
  const toastB = page.locator(".toast").filter({ hasText: b.text });
  await expect(toastA).toBeVisible({ timeout: 10_000 });
  await expect(toastB).toBeVisible();
  await expect(toastA.locator("[data-toast-note]")).toHaveText("bring the invoice");
  await expect(toastB.locator("[data-toast-note]")).toHaveCount(0);

  await page.request.patch(`/api/later/${encodeURIComponent(`${a.room}:${a.id}`)}`, { data: { state: "done" } });
  await expect(toastA).toHaveCount(0);
  await expect(toastB).toBeVisible();
  await page.request.patch(`/api/later/${encodeURIComponent(`${b.room}:${b.id}`)}`, { data: { remindAt: Date.now() + 3_600_000 } });
  await expect(toastB).toHaveCount(0);
});

test("Undo after Remove from Saved brings the row back with its reminder", async ({ page }) => {
  const a = await post(page);
  const remindAt = Date.now() + 2 * 3_600_000;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt } });
  await open(page, "#/c/saved?test=1", "later-page");
  const row = page.locator(`[data-later-id="${a.room}:${a.id}"]`);
  await expect(row.locator("[data-later-due]")).toContainText("Due");
  await row.hover();
  await row.locator("[data-later-remove]").click();
  await expect(row).toHaveCount(0);
  await page.locator(".toast").filter({ hasText: "Removed from Saved" }).getByRole("button", { name: "Undo" }).click();
  await expect(row.locator("[data-later-due]")).toContainText("Due");
  await expect(page.locator(".toast").filter({ hasText: "Add memo" })).toHaveCount(0);
  expect((await item(page, `${a.room}:${a.id}`))?.remindAt).toBe(remindAt);
});

test("a post kept unread says when it comes back unread, not a due time", async ({ page }) => {
  const a = await post(page);
  await page.request.post(`/api/c/${a.room}/read`, { data: { unreadFrom: a.id } });
  await open(page, "#/c/saved?test=1", "later-page");
  const row = page.locator(`[data-later-id="${a.room}:${a.id}"]`);
  await expect(row.locator("[data-later-due]")).toContainText("Comes back unread");
  await row.hover();
  await row.locator("[data-later-remind]").click();
  const menu = page.getByRole("menu", { name: "Change when it comes back" });
  await expect(menu.getByRole("menuitem").last()).toHaveText("Don't bring it back");
});

test("the Mac app's reminder notification has Snooze and Mark complete buttons that act on the reminder", async ({ page }) => {
  // A stand-in for Tauri's IPC: it grants the permission, records each command and keeps the action listener's channel callback.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    w.__calls = calls;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return cmd.endsWith("is_permission_granted") ? true : null;
      },
      transformCallback: (callback: (raw: unknown) => void) => {
        w.__channel = callback;
        return 7;
      },
    };
  });
  const [a, b] = await twoPosts(page);
  await open(page, `#/c/${a.room}?test=1`);
  type Call = { cmd: string; args?: { types?: { id: string; actions: { title: string }[] }[]; event?: string; handler?: string; options?: { title: string; actionTypeId?: string; extra?: { row: { id: string } } } } };
  const calls = () => page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls) as Promise<Call[]>;
  await expect.poll(async () => (await calls()).find((c) => c.cmd === "plugin:notification|register_action_types")?.args?.types?.[0]?.actions.map((x) => x.title))
    .toEqual(["Snooze 20 minutes", "Snooze 1 hour", "Snooze until tomorrow", "Mark complete"]);
  expect((await calls()).find((c) => c.cmd === "plugin:notification|register_listener")?.args).toEqual({ event: "actionPerformed", handler: "__CHANNEL__:7" });

  const due = Date.now() + 1500;
  await page.request.post("/api/later", { data: { room: a.room, post: a.id, remindAt: due } });
  await page.request.post("/api/later", { data: { room: b.room, post: b.id, remindAt: due } });
  const shown = async (id: string) => (await calls()).find((c) => c.cmd === "plugin:notification|notify" && c.args?.options?.extra?.row.id === id)?.args?.options;
  await expect.poll(async () => (await shown(`${a.room}:${a.id}`))?.actionTypeId, { timeout: 10_000 }).toBe("reminder");
  await expect.poll(async () => !!(await shown(`${b.room}:${b.id}`)), { timeout: 10_000 }).toBe(true);

  const press = (actionId: string, notification: unknown) =>
    page.evaluate(([actionId, notification]) => (window as unknown as { __channel: (raw: unknown) => void }).__channel({ message: { actionId, inputValue: null, notification }, index: 0 }), [actionId, notification] as const);
  const before = Date.now();
  await press("snooze-1h", await shown(`${a.room}:${a.id}`));
  await expect.poll(async () => ((await item(page, `${a.room}:${a.id}`))?.remindAt ?? 0) - before).toBeGreaterThan(3_500_000);
  await press("complete", await shown(`${b.room}:${b.id}`));
  await expect.poll(async () => (await item(page, `${b.room}:${b.id}`))?.state).toBe("done");
});

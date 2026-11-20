import { test } from "node:test";
import assert from "node:assert/strict";
import { LaterDue, type DueItem } from "../../server/later-due.ts";
import type { MenuEntry } from "../../web/src/lib/ui/menu.ts";
import { dueLabel, fromPicker, nextMonday, pickerValues, remindedText, remindMenu, remindPresets } from "../../web/src/lib/remind.ts";

function rig(items: DueItem[], start: number) {
  let now = start;
  const fired: string[] = [];
  const due = new LaterDue({
    items: () => items,
    notified: (item, at) => {
      const i = items.findIndex(x => x.id === item.id);
      if (i < 0) return undefined;
      items[i] = { ...items[i]!, notifiedAt: at };
      due.arm();
      return items[i];
    },
    fire: item => fired.push(item.id),
    now: () => now,
  });
  return { due, fired, items, tick: (ms: number) => (now += ms) };
}

test("a reminder that fell due while the server was down fires once on boot, and only the owner's open ones", () => {
  const { due, fired } = rig([
    { id: "a", by: "owner", state: "open", remindAt: 900 },
    { id: "b", by: "owner", state: "done", remindAt: 900 },
    { id: "c", by: "ag_vent", state: "open", remindAt: 900 },
    { id: "d", by: "owner", state: "open", remindAt: 800, notifiedAt: 850 },
    { id: "e", by: "owner", state: "open" },
  ], 1000);
  due.arm();
  due.arm();
  due.stop();
  assert.deepEqual(fired, ["a"]);
});

test("the timer fires at the earliest reminder, and a snooze past notifiedAt fires again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = rig([
    { id: "a", by: "owner", state: "open", remindAt: 5000 },
    { id: "b", by: "owner", state: "open", remindAt: 9000 },
  ], 1000);
  r.due.arm();
  r.tick(4000);
  t.mock.timers.tick(4000);
  assert.deepEqual(r.fired, ["a"]);
  r.items[0] = { ...r.items[0]!, remindAt: 7000 };
  r.due.arm();
  r.tick(2000);
  t.mock.timers.tick(2000);
  assert.deepEqual(r.fired, ["a", "a"]);
  r.tick(2000);
  t.mock.timers.tick(2000);
  assert.deepEqual(r.fired, ["a", "a", "b"]);
  r.due.stop();
});

test("presets land where Slack's do, in local time", () => {
  const wed = new Date(2026, 10, 18, 14, 30).getTime();
  const at = Object.fromEntries(remindPresets(wed).map(p => [p.id, new Date(p.at)]));
  assert.equal(at["20m"]!.getTime() - wed, 20 * 60_000);
  assert.equal(at["3h"]!.getTime() - wed, 3 * 3_600_000);
  assert.deepEqual([at.tomorrow!.getDate(), at.tomorrow!.getHours(), at.tomorrow!.getMinutes()], [19, 9, 0]);
  assert.deepEqual([at["next-week"]!.getDay(), at["next-week"]!.getDate(), at["next-week"]!.getHours()], [1, 23, 9]);
  const mon = new Date(2026, 10, 23, 8, 0).getTime();
  assert.equal(new Date(nextMonday(mon)).getDate(), 30);
});

test("a row says Due before the time and Overdue after, and the picker round-trips", () => {
  const now = new Date(2026, 10, 18, 14, 30).getTime();
  assert.equal(dueLabel(new Date(2026, 10, 18, 15, 40).getTime(), now).text, "Due 3:40 PM");
  assert.equal(dueLabel(new Date(2026, 10, 19, 9, 0).getTime(), now).text, "Due Tomorrow at 9:00 AM");
  assert.deepEqual(dueLabel(new Date(2026, 10, 18, 14, 0).getTime(), now), { text: "Overdue · 2:00 PM", due: true });
  const v = pickerValues(now);
  assert.deepEqual(v, { date: "2026-11-18", time: "14:30" });
  assert.equal(fromPicker(v.date, v.time), now);
  assert.equal(fromPicker("", "10:00"), null);
});

test("the toast and the submenu word a reminder as Slack does", () => {
  const now = new Date(2026, 10, 18, 14, 30).getTime();
  assert.equal(remindedText(new Date(2026, 10, 18, 14, 50).getTime(), now), "We'll remind you at 2:50 PM");
  assert.equal(remindedText(new Date(2026, 10, 19, 9, 0).getTime(), now), "We'll remind you tomorrow at 9:00 AM");
  assert.equal(remindedText(new Date(2026, 10, 23, 9, 0).getTime(), now), "We'll remind you on Monday at 9:00 AM");
  const picked: number[] = [];
  const plain = remindMenu({ set: at => picked.push(at), custom: () => {}, clear: () => {}, now });
  assert.deepEqual(plain.items.map((e: MenuEntry) => ("label" in e ? e.label : "-")), ["In 20 minutes", "In 1 hour", "In 3 hours", "Tomorrow", "Next week", "-", "Custom…"]);
  const set = remindMenu({ remindAt: new Date(2026, 10, 18, 15, 40).getTime(), set: () => {}, custom: () => {}, clear: () => {}, now });
  assert.deepEqual(set.items.slice(0, 2).map((e: MenuEntry) => ("label" in e ? e.label : "-")), ["Due 3:40 PM", "Remove reminder"]);
});

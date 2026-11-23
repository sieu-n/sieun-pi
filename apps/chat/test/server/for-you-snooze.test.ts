/**
 * Remind me on a For you ask: the owner's remindAt hides an open todo from the For you count until its time, an agent cannot set it, and the
 * count comes back by itself when the time passes.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/for-you-snooze.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => { s = await start(); });
after(async () => { await s.close(); });

const openAsk = async (): Promise<{ chatId: string; id: string }> => {
  const items = (await s.app.boards.forYou()).filter(item => !item.todo.done);
  assert.ok(items.length > 0);
  return { chatId: items[0]!.chatId, id: items[0]!.todo.id };
};

test("remindAt hides an open ask from the For you count until it comes due", async () => {
  const { chatId, id } = await openAsk();
  const count = await s.app.boards.forYouCount();
  // A minute away, so the count below reads it hidden however slow a busy box runs it (this test took 7.8 s in a full suite run at load 600 on 11-23).
  const later = new Date(Date.now() + 60_000).toISOString();
  const view = await s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: later }]);
  assert.equal(view.board?.todos.find(todo => todo.id === id)?.remindAt, later);
  assert.match(view.summaries[0]!, /set a reminder on .* so it leaves For you until then/);
  assert.equal(await s.app.boards.forYouCount(), count - 1);
  const counts: number[] = [];
  const events = s.app.boards.events as { forYou(count: number): void };
  const real = events.forYou.bind(events);
  events.forYou = (next: number) => { counts.push(next); real(next); };
  try {
    // The owner moves it to 400 ms from now; when it comes due the server sends the count again on its own.
    await s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: new Date(Date.now() + 400).toISOString() }]);
    await until(async () => counts.includes(count), found => found, 5_000).catch(() => undefined);
    assert.ok(counts.includes(count), `the due reminder sent the count again: ${counts.join(", ")}`);
  } finally {
    events.forYou = real;
  }
  await s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: null }]);
  assert.equal((await s.app.boards.board(chatId))?.todos.find(todo => todo.id === id)?.remindAt, undefined);
});

test("a count read after a reminder's time, before its timer ran, still sends the ask back", async () => {
  const { chatId, id } = await openAsk();
  const count = await s.app.boards.forYouCount();
  const due: string[] = [];
  const counts: number[] = [];
  const events = s.app.boards.events as { forYou(count: number): void; asksDue?(items: { todo: { id: string } }[], now: number): void };
  const real = { forYou: events.forYou.bind(events), asksDue: events.asksDue?.bind(events) };
  events.forYou = next => { counts.push(next); real.forYou(next); };
  events.asksDue = (items, now) => { due.push(...items.map(item => item.todo.id)); real.asksDue?.(items, now); };
  try {
    const at = Date.now() + 100;
    await s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: new Date(at).toISOString() }]);
    // A busy box: the loop runs nothing until past the reminder's time and its timer's 50 ms, then a page reads the count (App.sidebar).
    while (Date.now() < at + 200) { /* hold the loop */ }
    assert.equal(await s.app.boards.forYouCount(), count);
    await until(async () => due.length > 0 && counts.includes(count), sent => sent, 5_000).catch(() => undefined);
    assert.deepEqual(due, [id], "the ask went out as due");
    assert.ok(counts.includes(count), `the count went out again: ${counts.join(", ")}`);
  } finally {
    events.forYou = real.forYou;
    events.asksDue = real.asksDue;
    await s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: null }]);
  }
});

test("an agent cannot set Remind me, and a bad time is refused", async () => {
  const { chatId, id } = await openAsk();
  await assert.rejects(s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: new Date(Date.now() + 60_000).toISOString() }], "agent"), /Only the owner sets Remind me/);
  await assert.rejects(s.app.boards.apply(chatId, [{ op: "todo_update", id, remindAt: "tomorrow" }]), /remindAt must be an ISO time/);
});

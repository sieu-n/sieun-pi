// 10-18 owner report on us-metal02: "the web server sieu-pi keep crashing, super buggy". Each chat switch asked api/accounts, which ran 4 pi-pool
// processes and took 1.0 to 2.2 s on the box and 5.1 to 14 s from the owner's Mac. The answer now comes from the last reading at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetAccountReadings, listAccounts } from "../src/chat-pool.ts";
import type { AccountsView } from "../src/shared/types.ts";

function fakePool() {
  const asks: { sessionId: string | null; model: string | null; answer: (view: AccountsView) => void }[] = [];
  let made = 0;
  const read = (sessionId: string | null, model: string | null) => new Promise<AccountsView>(resolve => {
    asks.push({ sessionId, model, answer: resolve });
  });
  const view = (): AccountsView => ({ sessionId: null, checkedAt: String(++made), providers: [], poolConfig: null, priority: null });
  return { asks, read, view };
}

test("a second ask for a thread answers with the last reading at once and starts one new reading behind it", async () => {
  forgetAccountReadings();
  const pool = fakePool();
  const first = listAccounts("t1", "opus", { read: pool.read });
  assert.equal(pool.asks.length, 1);
  const one = pool.view();
  pool.asks[0]!.answer(one);
  assert.equal(await first, one);

  const second = await listAccounts("t1", "opus", { read: pool.read });
  assert.equal(second, one);
  assert.equal(pool.asks.length, 2);
  assert.equal(await listAccounts("t1", "opus", { read: pool.read }), one);
  assert.equal(pool.asks.length, 2, "a reading in flight is shared, not run again");

  const two = pool.view();
  pool.asks[1]!.answer(two);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await listAccounts("t1", "opus", { read: pool.read }), two);
});

test("another thread or model waits for its own reading", async () => {
  forgetAccountReadings();
  const pool = fakePool();
  pool.asks.length = 0;
  void listAccounts("t1", "opus", { read: pool.read });
  void listAccounts("t1", "sonnet", { read: pool.read });
  void listAccounts("t2", "opus", { read: pool.read });
  assert.deepEqual(pool.asks.map(ask => [ask.sessionId, ask.model]), [["t1", "opus"], ["t1", "sonnet"], ["t2", "opus"]]);
});

test("a pool change drops the readings, and fresh waits for a new one", async () => {
  forgetAccountReadings();
  const pool = fakePool();
  const first = listAccounts("t1", null, { read: pool.read });
  const old = pool.view();
  pool.asks[0]!.answer(old);
  await first;
  await new Promise(resolve => setImmediate(resolve));

  const fresh = listAccounts("t1", null, { read: pool.read, fresh: true });
  const newer = pool.view();
  pool.asks[1]!.answer(newer);
  assert.equal(await fresh, newer);
  await new Promise(resolve => setImmediate(resolve));

  forgetAccountReadings();
  const after = listAccounts("t1", null, { read: pool.read });
  const changed = pool.view();
  pool.asks[2]!.answer(changed);
  assert.equal(await after, changed, "after a pool change the ask waits instead of answering with the old reading");
});

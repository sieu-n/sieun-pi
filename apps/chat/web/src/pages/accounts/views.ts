/**
 * The account pool as the account chips show it, one answer per thread and model, shared by every chip that shows it. A chip that asks
 * while a read of its thread is on its way takes that read, and one that asks within `READ_AGAIN_MS` of the last read takes its answer:
 * the pool has no live event, so the chips' own timers read it again. The chips asked for in one task go out as one call: a channel
 * header shows one chip per agent member, and on 11-28 an open of #1124-cost-management read GET /api/accounts three times at once, and
 * a walk of live :5184 read it 12 times in 3 min (work/p324-dup-reads/live/r3). The calls go through client.ts, so each writes its timing
 * line, a first read as his wait and a read behind a shown chip as a refresh.
 */
import { get, type Wait } from "$lib/api/client";
import { READ_AGAIN_MS } from "$lib/api/read-ahead";
import type { AccountsView } from "$lib/api/shared/types.ts";

export type PoolOf = { thread: string | null; model: string | null };

/** One thread's answer: when its last read left the page (`performance.now()`), the answer, and the read on its way. */
type Entry = { left: number; value?: AccountsView; flight?: Promise<AccountsView> };
type Asked = { of: PoolOf; shown: boolean; resolve: (view: AccountsView) => void; reject: (error: unknown) => void };

const entries = new Map<string, Entry>();
let asked: Asked[] = [];

const param = (name: string, value: string | null) => `${name}=${encodeURIComponent(value ?? "")}`;
/** The one-thread path as the chip read it before, with no empty parameter. */
const onePath = ({ thread, model }: PoolOf): string => {
  const parts = [...(thread ? [param("thread", thread)] : []), ...(model ? [param("model", model)] : [])];
  return `/api/accounts${parts.length ? `?${parts.join("&")}` : ""}`;
};

/** The pool for `of`; `fresh` reads it again however new the last answer is, as after the owner changed the thread's account. */
export function accountsView(of: PoolOf, fresh = false): Promise<AccountsView> {
  const key = `${of.thread ?? ""}\u0000${of.model ?? ""}`;
  let entry = entries.get(key);
  if (!entry) entries.set(key, (entry = { left: -Infinity }));
  if (entry.flight) return entry.flight;
  if (!fresh && entry.value && performance.now() - entry.left < READ_AGAIN_MS) return Promise.resolve(entry.value);
  const mine = entry;
  mine.left = performance.now();
  const shown = mine.value !== undefined;
  const flight: Promise<AccountsView> = new Promise<AccountsView>((resolve, reject) => {
    if (!asked.length) queueMicrotask(send);
    asked.push({ of, shown, resolve, reject });
  }).then(view => {
    mine.value = view;
    return view;
  }).finally(() => {
    if (mine.flight === flight) mine.flight = undefined;
  });
  mine.flight = flight;
  return flight;
}

/** Sends what the chips asked in this task: one thread as GET /api/accounts, several as GET /api/accounts/views. */
function send(): void {
  const batch = asked;
  asked = [];
  const wait: Wait | undefined = batch.every(one => one.shown) ? { background: "shown" } : undefined;
  if (batch.length === 1) {
    const [one] = batch;
    get<AccountsView>({ path: onePath(one!.of) }, wait).then(one!.resolve, one!.reject);
    return;
  }
  const path = `/api/accounts/views?${batch.map(({ of }) => `${param("thread", of.thread)}&${param("model", of.model)}`).join("&")}`;
  get<{ views: AccountsView[] }>({ path }, wait).then(({ views }) => {
    batch.forEach((one, i) => (views[i] ? one.resolve(views[i]!) : one.reject(new Error("The pool did not answer for this thread"))));
  }, (error: unknown) => batch.forEach(one => one.reject(error)));
}

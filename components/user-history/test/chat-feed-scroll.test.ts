// Guards the owner's 10-22 ask "the scroll behaviour is super wierd janky should reliably load, scroll fast snappy": on the AI harness chat an
// older page folded the top drawn row into a run that started on that page, the window lost its top and jumped back to the newest 30 items
// (6 to 8 times in a 12 s scroll), a fold change above the view moved what the owner read by up to 352 px, and the feed held the bottom with
// an 8-frame loop and corrections that a scroll event, a clamp or a row drawn anew could undo.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chatFeed } from "../src/shared/chat-feed.ts";
import { prependOlder } from "../src/client/thread-pages.ts";
import { FIRST_ITEMS, earlierTop, holdPlace, laterBottom, settledFrom, windowEnd, windowStart } from "../src/client/feed-window.ts";
import type { ThreadMessage, ThreadState } from "../src/shared/types.ts";

const user = (at: number, text: string): ThreadMessage => ({ role: "user", content: text, timestamp: at }) as ThreadMessage;
const reply = (at: number, text: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at, api: "x", provider: "x", model: "x", usage: {} }) as unknown as ThreadMessage;
const thread = (messages: ThreadMessage[], older?: string): ThreadState =>
  ({ messages, streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null, connection: "connected", info: {} as ThreadState["info"],
    ...(older === undefined ? {} : { older }) }) as unknown as ThreadState;
const items = (state: ThreadState) => chatFeed(state).map(item => ({ key: item.id, at: item.at }));

test("an older page that folds the top drawn row into an earlier run keeps the window on that run, not the newest items", () => {
  const jobs = (from: number, count: number) => Array.from({ length: count }, (_, index) => user(from + index, `[from jobs] step ${from + index} done`));
  const talk = (from: number, count: number) => Array.from({ length: count }, (_, index) => index % 2 ? reply(from + index, "answer") : user(from + index, "ask"));
  const newest = thread([...jobs(1000, 3), ...talk(1100, 80)], "m1000.0");
  const before = items(newest);
  const top = before[0]!;
  const paged = prependOlder(newest, { messages: [...talk(900, 10), ...jobs(990, 4)], older: "m900.0" });
  const after = items(paged);
  assert.equal(after.some(item => item.key === top.key), false, "the run's key moved to its first line on the older page");
  const start = windowStart(after, top, FIRST_ITEMS);
  assert.ok(after[start]!.at <= top.at, "the window starts at or above the row it showed");
  assert.equal(after.length - start, before.length, "the rows the owner read all stay drawn");
  assert.equal(earlierTop(after, start, 30)?.key, after[Math.max(0, start - 30)]!.key);
});

const row = (height: number) => ({ offsetTop: 0, height, isConnected: true, nextElementSibling: null as unknown, get offsetHeight() { return this.height; } });
/** A scroller and a column of rows with fixed heights, laid out the way the browser would, and the one ResizeObserver holdPlace makes. */
function feed(heights: number[], view = 500) {
  const rows: ReturnType<typeof row>[] = [];
  const column = { children: rows, offsetHeight: 0 };
  const layout = () => { let y = 0; rows.forEach((row, index) => { row.offsetTop = y; y += row.height; row.nextElementSibling = rows[index + 1] ?? null; }); column.offsetHeight = y; };
  for (const height of heights) rows.push(row(height));
  layout();
  let top = 0;
  const scroller = {
    clientHeight: view,
    get scrollHeight() { return Math.max(view, column.offsetHeight); },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - view)); },
  };
  return { rows, column, scroller, layout };
}
let observed: (() => void) | null = null;
const realObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = class { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { observed = null; });
process.on("exit", () => { globalThis.ResizeObserver = realObserver; });

test("the feed opens at the bottom and stays there as rows grow, even when a scroll event lands between a change and its resize", () => {
  const f = feed(Array(20).fill(100));
  const pins: boolean[] = [];
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => true, pinned => pins.push(pinned));
  observed!();
  assert.equal(f.scroller.scrollTop, 1500);
  f.rows[19]!.height = 320;
  f.layout();
  place.scrolled();
  observed!();
  assert.equal(f.scroller.scrollTop, 1720);
  assert.deepEqual(pins, []);
});

test("scrolled up, rows drawn or grown above the view leave the row the owner reads where it was on screen", () => {
  const f = feed(Array(20).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => true, () => {});
  observed!();
  f.scroller.scrollTop = 600;
  place.scrolled();
  const reading = f.rows[8]!;
  const onScreen = reading.offsetTop - f.scroller.scrollTop;
  f.rows.unshift(...Array.from({ length: 30 }, () => row(60)));
  f.rows[31]!.height = 237;
  f.layout();
  place.scrolled();
  observed!();
  assert.equal(reading.offsetTop - f.scroller.scrollTop, onScreen);
  f.rows.push(row(400));
  f.layout();
  observed!();
  assert.equal(reading.offsetTop - f.scroller.scrollTop, onScreen, "a new line below does not move it either");
});

test("a window that stopped above the newest ends on its bottom item, or on the run that took it in, and draws on to the newest", () => {
  const all = Array.from({ length: 200 }, (_, index) => ({ key: "k" + index, at: 1000 + index * 10 }));
  assert.equal(windowEnd(all, null), 200);
  assert.equal(windowEnd(all, all[119]!), 120);
  const folded = all.filter(item => item.key !== "k119");
  assert.equal(folded[windowEnd(folded, all[119]!) - 1]!.key, "k118");
  assert.equal(laterBottom(all, 120, 30)?.key, "k149");
  assert.equal(laterBottom(all, 180, 30), null);
});

test("rows drawn above and taken off below in one change, with the column's height unchanged, still leave the read row in place", () => {
  const f = feed(Array(40).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => false, () => {});
  observed!();
  f.scroller.scrollTop = 1200;
  place.scrolled();
  const reading = f.rows[17]!;
  const onScreen = reading.offsetTop - f.scroller.scrollTop;
  f.rows.unshift(...Array.from({ length: 10 }, () => row(100)));
  f.rows.splice(-10, 10);
  f.layout();
  place.hold();
  assert.equal(reading.offsetTop - f.scroller.scrollTop, onScreen);
});

test("rows taken off above near the end of the window leave the read row in place though the browser clamped the scroll first", () => {
  const f = feed(Array(60).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => false, () => {});
  observed!();
  f.scroller.scrollTop = 5300;
  place.scrolled();
  const reading = f.rows[57]!;
  const onScreen = reading.offsetTop - f.scroller.scrollTop;
  f.rows.splice(0, 30);
  f.layout();
  f.scroller.scrollTop = f.scroller.scrollTop;
  f.rows.push(...Array.from({ length: 7 }, () => row(100)));
  f.layout();
  place.hold();
  assert.equal(reading.offsetTop - f.scroller.scrollTop, onScreen);
});

test("a scroll that lands between a change and its resize moves the read row with the owner instead of being undone", () => {
  const f = feed(Array(40).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => false, () => {});
  observed!();
  f.scroller.scrollTop = 2000;
  place.scrolled();
  const reading = f.rows[25]!;
  const onScreen = reading.offsetTop - f.scroller.scrollTop;
  f.rows.unshift(...Array.from({ length: 5 }, () => row(100)));
  f.layout();
  f.scroller.scrollTop -= 100;
  place.scrolled();
  observed!();
  assert.equal(reading.offsetTop - f.scroller.scrollTop, onScreen + 100);
});

test("when the read row is drawn anew, as a time stamp can be, the row after it holds the place", () => {
  const f = feed(Array(40).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => false, () => {});
  observed!();
  f.scroller.scrollTop = 2000;
  place.scrolled();
  const middle = f.rows[22]!;
  const after = f.rows[23]!;
  const onScreen = after.offsetTop - f.scroller.scrollTop;
  middle.isConnected = false;
  f.rows.splice(22, 1, row(100));
  f.rows.unshift(...Array.from({ length: 8 }, () => row(100)));
  f.layout();
  observed!();
  assert.equal(after.offsetTop - f.scroller.scrollTop, onScreen);
});

test("a scroll up from the bottom that lands between a change and its resize leaves the bottom instead of being pulled back", () => {
  const f = feed(Array(20).fill(100));
  const pins: boolean[] = [];
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => true, pinned => pins.push(pinned));
  observed!();
  f.rows.unshift(...Array.from({ length: 5 }, () => row(100)));
  f.layout();
  f.scroller.scrollTop -= 100;
  place.scrolled();
  observed!();
  assert.deepEqual(pins, [false]);
  assert.equal(f.scroller.scrollTop, 1900);
});

test("while older pages are unloaded the window draws from the first owner message, since the lines above it can still change", () => {
  const notes = Array.from({ length: 6 }, (_, index) => reply(1000 + index, "working on it " + index));
  const turn = [user(2000, "how is it going"), reply(2001, "fine")];
  const newest = thread([...notes, ...turn], "m1000.0");
  const kinds = chatFeed(newest).map(item => item.kind);
  const floor = settledFrom(kinds, true);
  assert.equal(kinds[floor], "user");
  assert.ok(floor > 0);
  assert.equal(settledFrom(kinds, false), 0);
  assert.equal(earlierTop(items(newest), floor, 30, floor), null, "nothing above the floor is drawn until the older page loads");
});

test("a reply in the middle of the view that grows a quote when its older page loads grows upward, so the text after it stays put", () => {
  const f = feed(Array(40).fill(100));
  const place = holdPlace(f.scroller as unknown as HTMLElement, f.column as unknown as HTMLElement, () => false, () => {});
  observed!();
  f.scroller.scrollTop = 2000;
  place.scrolled();
  const after = f.rows[23]!;
  const onScreen = after.offsetTop - f.scroller.scrollTop;
  f.rows[22]!.height += 65;
  f.rows.unshift(...Array.from({ length: 8 }, () => row(100)));
  f.layout();
  observed!();
  assert.equal(after.offsetTop - f.scroller.scrollTop, onScreen);
});

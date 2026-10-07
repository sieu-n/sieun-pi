import assert from "node:assert/strict";
import { mock, test } from "node:test";

/** A stand-in DOM: nodes with a parent and a dataset, and a document that keeps the listeners `previewTriggers` installs. */
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  constructor(readonly dataset: Record<string, string | undefined> = {}) {}
  add(child: FakeNode): FakeNode { child.parent = this; this.children.push(child); return child; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector: string): FakeNode | null {
    const key = selector.slice(6, -1).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    for (let node: FakeNode | null = this; node; node = node.parent) if (key in node.dataset) return node;
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
}
const listeners = new Map<string, (event: unknown) => void>();
Object.assign(globalThis, {
  Element: FakeNode,
  Node: FakeNode,
  document: {
    addEventListener: (type: string, run: (event: unknown) => void) => { listeners.set(type, run); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  },
});
const { HOVER_DELAY, LEAVE_GRACE, PRESS_DELAY, previewTriggers, triggerOf } = await import("../src/client/preview.ts");

const node = (fake: FakeNode) => fake as unknown as HTMLElement;
const page = new FakeNode();
const row = page.add(new FakeNode({ previewChat: "chat-1", previewJob: "ux-email" }));
const rowLabel = row.add(new FakeNode());
const chip = page.add(new FakeNode({ previewChat: "chat-1", previewJob: "session:01a1-root" }));
const notesOnly = page.add(new FakeNode({ previewChat: "chat-1", previewJob: undefined }));
const plain = page.add(new FakeNode());

test("triggerOf maps a press or hover on a trigger, or any node inside it, to its chat and job", () => {
  assert.deepEqual(triggerOf(node(row)), { chat: "chat-1", job: "ux-email", anchor: row });
  assert.deepEqual(triggerOf(node(rowLabel)), { chat: "chat-1", job: "ux-email", anchor: row }, "a node inside the trigger");
  assert.deepEqual(triggerOf(node(chip)), { chat: "chat-1", job: "session:01a1-root", anchor: chip }, "a job opened by session id");
  assert.equal(triggerOf(node(notesOnly)), null, "a folded run of notes only has no job to preview");
  assert.equal(triggerOf(node(plain)), null);
  assert.equal(triggerOf(null), null);
  assert.equal(triggerOf("text" as never), null);
});

function host() {
  const log: string[] = [];
  let shown: ReturnType<typeof triggerOf> = null;
  const card = new FakeNode();
  const cardText = card.add(new FakeNode());
  const stop = previewTriggers({
    show: trigger => { shown = trigger; log.push("show " + trigger.job); },
    hide: () => { if (shown) log.push("hide"); shown = null; },
    card: () => shown ? node(card) : null,
    shown: () => shown,
  });
  const fire = (type: string, event: Record<string, unknown>) => listeners.get(type)!(event);
  const mouse = (type: string, target: FakeNode | null, extra: Record<string, unknown> = {}) => fire(type, { pointerType: "mouse", target, relatedTarget: target, ...extra });
  const touch = (type: string, target: FakeNode, x = 0, y = 0) => fire(type, { pointerType: "touch", target, clientX: x, clientY: y });
  return { log, card, cardText, stop, fire, mouse, touch, shown: () => shown };
}

test("a mouse resting on a trigger for 300 ms shows its card; the card stays over the trigger or itself and goes 120 ms after the pointer rests elsewhere", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const page = host();
  page.mouse("pointerover", rowLabel);
  mock.timers.tick(HOVER_DELAY - 1);
  assert.deepEqual(page.log, [], "not yet");
  mock.timers.tick(1);
  assert.deepEqual(page.log, ["show ux-email"]);
  page.mouse("pointerover", row);
  page.mouse("pointerover", page.cardText);
  mock.timers.tick(LEAVE_GRACE * 2);
  assert.deepEqual(page.log, ["show ux-email"], "over the trigger and the card the card stays");
  page.mouse("pointerover", plain);
  mock.timers.tick(LEAVE_GRACE - 1);
  page.mouse("pointerover", page.cardText);
  mock.timers.tick(LEAVE_GRACE * 2);
  assert.deepEqual(page.log, ["show ux-email"], "back on the card within the grace keeps it");
  page.mouse("pointerover", plain);
  mock.timers.tick(LEAVE_GRACE);
  assert.deepEqual(page.log, ["show ux-email", "hide"]);
  page.mouse("pointerover", row);
  mock.timers.tick(HOVER_DELAY - 1);
  page.mouse("pointerover", plain);
  mock.timers.tick(HOVER_DELAY);
  assert.deepEqual(page.log, ["show ux-email", "hide"], "leaving before 300 ms shows nothing");
  page.stop();
  mock.timers.reset();
});

test("moving from one trigger to another swaps the card; a mouse press, Escape and a scroll outside the card close it; a touch held 500 ms opens it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const page = host();
  page.mouse("pointerover", row);
  mock.timers.tick(HOVER_DELAY);
  page.mouse("pointerover", chip);
  mock.timers.tick(HOVER_DELAY);
  assert.deepEqual(page.log, ["show ux-email", "hide", "show session:01a1-root"]);
  page.fire("pointerdown", { pointerType: "mouse", target: page.cardText });
  assert.equal(page.shown()?.job, "session:01a1-root", "a press inside the card keeps it");
  page.fire("pointerdown", { pointerType: "mouse", target: chip });
  assert.equal(page.shown(), null, "a press on the trigger closes the card, the click opens the full report");
  page.mouse("pointerover", row);
  mock.timers.tick(HOVER_DELAY);
  const escape = { key: "Escape", preventDefault: mock.fn(), stopPropagation: mock.fn() };
  page.fire("keydown", escape);
  assert.equal(page.shown(), null);
  assert.equal(escape.preventDefault.mock.callCount(), 1, "Escape is consumed while a card is up");
  page.fire("keydown", escape);
  assert.equal(escape.preventDefault.mock.callCount(), 1, "and passed on when none is");
  page.mouse("pointerover", row);
  mock.timers.tick(HOVER_DELAY);
  page.fire("scroll", { target: page.cardText });
  assert.equal(page.shown()?.job, "ux-email", "scrolling inside the card keeps it");
  page.fire("scroll", { target: plain });
  assert.equal(page.shown(), null, "scrolling the page closes it");
  page.mouse("pointerover", row);
  mock.timers.tick(HOVER_DELAY);
  page.mouse("pointerout", row, { relatedTarget: null });
  mock.timers.tick(LEAVE_GRACE);
  assert.equal(page.shown(), null, "the pointer leaving the window closes it");
  page.touch("pointerdown", rowLabel);
  mock.timers.tick(PRESS_DELAY - 1);
  page.touch("pointermove", rowLabel, 3, 3);
  mock.timers.tick(1);
  assert.equal(page.shown()?.job, "ux-email", "a touch held 500 ms with a 3 px wobble opens the card");
  page.touch("pointerdown", chip);
  assert.equal(page.shown(), null, "the next touch closes it");
  page.touch("pointermove", chip, 20, 0);
  mock.timers.tick(PRESS_DELAY);
  assert.equal(page.shown(), null, "a finger that moved 20 px is a scroll, not a press");
  page.touch("pointerdown", chip);
  mock.timers.tick(PRESS_DELAY / 2);
  page.touch("pointerup", chip);
  mock.timers.tick(PRESS_DELAY);
  assert.equal(page.shown(), null, "a tap lifted before 500 ms is a click");
  page.stop();
  assert.equal(listeners.size, 0, "stop removes every document listener");
  mock.timers.reset();
});

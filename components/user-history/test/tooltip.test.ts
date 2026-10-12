import assert from "node:assert/strict";
import { test } from "node:test";
import { placeTooltip, tooltipHost } from "../src/client/ui/tooltip.ts";

const VIEW = { width: 1200, height: 800 };
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("a tooltip inside an open modal dialog joins the dialog, so it draws in the top layer above the modal", () => {
  const body = { id: "body" } as unknown as HTMLElement;
  const dialog = { id: "dialog" } as unknown as HTMLElement;
  assert.equal(tooltipHost({ closest: (selector: string) => selector === "dialog[open]" ? dialog : null }, body), dialog);
  assert.equal(tooltipHost({ closest: () => null }, body), body);
});

test("a right-side tooltip sits next to its control, centered on it, with the tail pointing back", () => {
  const place = placeTooltip(box(230, 140, 130, 28), { width: 200, height: 40 }, VIEW, "right");
  assert.deepEqual(place, { left: 368, top: 134, tail: { side: "left", offset: 16 } });
});

test("a right-side tooltip with no room on the right goes left of its control", () => {
  const place = placeTooltip(box(1100, 140, 90, 28), { width: 200, height: 40 }, VIEW, "right");
  assert.equal(place.left, 892);
  assert.equal(place.tail.side, "right");
});

test("the default tooltip goes above its control, or below when the top has no room", () => {
  assert.deepEqual(placeTooltip(box(500, 300, 40, 40), { width: 100, height: 30 }, VIEW, "above"), { left: 470, top: 262, tail: { side: "bottom", offset: 46 } });
  assert.equal(placeTooltip(box(500, 10, 40, 40), { width: 100, height: 30 }, VIEW, "above").tail.side, "top");
});

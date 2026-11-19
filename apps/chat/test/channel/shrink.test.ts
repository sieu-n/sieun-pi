import { test } from "node:test";
import assert from "node:assert/strict";
import { worthIt } from "../../web/src/lib/api/shrink.ts";

const shot = { bytes: 1_756_844, px: 3178 * 2282 };
const ratio = { from: 1_756_844, to: 235_458 };

test("the first PNG of a browser is encoded, since nothing is measured yet", () => {
  assert.equal(worthIt(shot, undefined, 200), true);
  assert.equal(worthIt(shot, { px: shot.px, ms: 1100, ...ratio }, undefined), true);
});

test("a PNG that fits TCP's first flight is never encoded", () => {
  assert.equal(worthIt({ bytes: 14_600, px: 100 * 100 }, undefined, 200), false);
});

test("the encode runs only when it costs less than the round trips the smaller file saves", () => {
  const box = { px: shot.px, ms: 1100, ...ratio };
  assert.equal(worthIt(shot, box, 200), false, "1,100 ms of encode against 580 ms saved at a 200 ms round trip");
  assert.equal(worthIt(shot, box, 600), true, "1,100 ms of encode against 1,740 ms saved at a 600 ms round trip");
  assert.equal(worthIt(shot, { ...box, ms: 400 }, 200), true, "400 ms of encode against 580 ms saved");
  assert.equal(worthIt(shot, { ...box, ms: 400 }, 5), false, "next to the box nothing is saved");
});

test("an encode that made files no smaller saves nothing", () => {
  assert.equal(worthIt(shot, { px: shot.px, ms: 10, from: 1000, to: 1000 }, 200), false);
});

/**
 * edit_message holds an edit that runs long once, as tell_owner does (`longEdit`, c98): on 11-21 a blind run's work thread grew a checklist
 * over its edits from 54 to 78 to 86 words.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LONG_EDIT_MARK, longEdit } from "../../src/durable/room-tools.ts";

const checklist = (items: number) => ["yes, both boxes match main and every link resolves", "- this box",
  ...Array.from({ length: items }, (_, i) => `  - [x] check ${i + 1} passed on the box with nothing left`)].join("\n");

test("an edit over 80 words is held once with a note, and the very same text sent again goes out", () => {
  const held = new Set<string>();
  const long = checklist(12);
  const note = longEdit(long, held);
  assert.ok(note?.startsWith(LONG_EDIT_MARK), note);
  assert.match(note!, /words in all/);
  assert.equal(longEdit(long, held), undefined, "the resend edits the post");
});

test("list and task markers are no words, so a checklist of 74 words that is 96 tokens with them passes", () => {
  const held = new Set<string>();
  assert.equal(longEdit(checklist(7), held), undefined);
  assert.equal(held.size, 0);
});

/**
 * edit_message holds once an edit whose line crams several results (`crammedEdit`, c98), as tell_owner holds such a post: on 11-21 the first
 * blind-threads.mjs run's last edit put four results on its top line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CRAMMED_EDIT_MARK, crammedEdit } from "../../src/durable/comm-guard.ts";

const crammed = "The Elixir app has 37 source files, 9,845 lines and 16 test files; its 234 tests take about 35 s.\n- size\n  - [x] 37 .ex files under lib/";

test("an edit whose top line crams four results is held once, and the resend goes out", () => {
  const held = new Set<string>();
  assert.ok(crammedEdit(crammed, held)?.startsWith(CRAMMED_EDIT_MARK));
  assert.equal(crammedEdit(crammed, held), undefined);
});

test("an edit with a short answer on top and the results in items goes out", () => {
  const edit = "measured, it is a small app\n- size\n  - [x] 37 source files, 9,845 lines\n  - [x] 16 test files\n- tests\n  - [x] 234 tests in about 35 s";
  assert.equal(crammedEdit(edit, new Set()), undefined);
});

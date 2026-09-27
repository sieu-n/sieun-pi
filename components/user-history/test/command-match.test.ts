import assert from "node:assert/strict";
import { test } from "node:test";
import { insertSlashCommand, slashTokenAt } from "../src/client/command-match.ts";

test("a slash token opens at the start of the text, after a space and after a newline", () => {
  assert.deepEqual(slashTokenAt("/po", 3), { start: 0, end: 3, query: "po" });
  assert.deepEqual(slashTokenAt("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(slashTokenAt("fix this /co", 12), { start: 9, end: 12, query: "co" });
  assert.deepEqual(slashTokenAt("first line\n/sk", 14), { start: 11, end: 14, query: "sk" });
  assert.deepEqual(slashTokenAt("a\n\n/", 4), { start: 3, end: 4, query: "" });
});

test("a slash inside a word or a URL is not a command", () => {
  assert.equal(slashTokenAt("see http://a/b", 14), null);
  assert.equal(slashTokenAt("a/b", 3), null);
  assert.equal(slashTokenAt("/cmd done", 9), null, "the caret sits in a later word");
  assert.equal(slashTokenAt("/cmd ", 5), null, "the caret sits after the space");
  assert.equal(slashTokenAt("", 0), null);
  assert.equal(slashTokenAt("plain", 5), null);
});

test("the query ends at the caret while the token spans the whole word", () => {
  assert.deepEqual(slashTokenAt("/poteto-mode", 3), { start: 0, end: 12, query: "po" });
  assert.deepEqual(slashTokenAt("x /compact now", 4), { start: 2, end: 10, query: "c" });
  assert.equal(slashTokenAt("/cmd", 0), null, "the caret before the slash is outside the word");
});

test("picking a command replaces only the token and leaves the caret after the inserted space", () => {
  assert.deepEqual(insertSlashCommand("first line\n/sk", slashTokenAt("first line\n/sk", 14)!, "skill:poteto-mode"),
    { text: "first line\n/skill:poteto-mode ", caret: 30 });
  assert.deepEqual(insertSlashCommand("x /compact now", slashTokenAt("x /compact now", 4)!, "compact"), { text: "x /compact now", caret: 11 });
  assert.deepEqual(insertSlashCommand("a /co\nb", slashTokenAt("a /co\nb", 5)!, "compact"), { text: "a /compact \nb", caret: 11 }, "the caret stays on its line");
  assert.deepEqual(insertSlashCommand("/co", slashTokenAt("/co", 3)!, "compact"), { text: "/compact ", caret: 9 });
});

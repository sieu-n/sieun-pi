import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorStamp, hashFor, parseHash, permalink } from "../src/client/permalink.ts";

test("parseHash reads a thread, a thread with a message, and nothing", () => {
  assert.deepEqual(parseHash("#01a112e2-f720-75db-b51a-84cfbdbcffa0"), { id: "01a112e2-f720-75db-b51a-84cfbdbcffa0", at: null });
  assert.deepEqual(parseHash("#01a112e2-f720-75db-b51a-84cfbdbcffa0@1759780000000"), { id: "01a112e2-f720-75db-b51a-84cfbdbcffa0", at: 1759780000000 });
  assert.deepEqual(parseHash("#%4001a112e2@abc"), { id: "@01a112e2@abc", at: null });
  assert.equal(parseHash("#"), null);
  assert.equal(parseHash(""), null);
});

test("hashFor and permalink build the hash parseHash reads back", () => {
  assert.equal(hashFor("abc"), "#abc");
  assert.equal(hashFor("abc", 5), "#abc@5");
  assert.deepEqual(parseHash(hashFor("a b", 7)), { id: "a b", at: 7 });
  assert.equal(permalink("abc", 5, { origin: "http://127.0.0.1:5182", pathname: "/tok/", search: "" }), "http://127.0.0.1:5182/tok/#abc@5");
});

test("anchorStamp prefers the exact message, else the nearest in time, the earlier one on a tie", () => {
  assert.equal(anchorStamp([10, 20, 30], 20), 20);
  assert.equal(anchorStamp([10, 20, 30], 24), 20);
  assert.equal(anchorStamp([10, 20, 30], 26), 30);
  assert.equal(anchorStamp([10, 20, 30], 25), 20);
  assert.equal(anchorStamp([10, 20, 30], 5), 10);
  assert.equal(anchorStamp([], 5), null);
});

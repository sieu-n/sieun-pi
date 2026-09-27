import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePublicOrigin } from "../src/chat-origin.ts";

test("public origins allow one explicit HTTPS origin or disable remote access", () => {
  assert.equal(parsePublicOrigin(null), null);
  assert.equal(parsePublicOrigin("none"), null);
  assert.equal(parsePublicOrigin("https://chat.example.ts.net/"), "https://chat.example.ts.net");
  assert.equal(parsePublicOrigin("https://chat.example:8443"), "https://chat.example:8443");
  for (const value of [undefined, 1, "", "*", "https://*.ts.net", "http://chat.example", "https://user:pass@chat.example", "https://chat.example/path", "https://chat.example/?x=1", "https://chat.example/#fragment", "https://chat.example?", "https://chat.example#"]) {
    assert.throws(() => parsePublicOrigin(value), /Use an HTTPS origin/);
  }
});

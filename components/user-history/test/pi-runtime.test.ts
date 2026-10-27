import assert from "node:assert/strict";
import { test } from "node:test";
import { onUpstreamPi } from "../src/pi-runtime.ts";

test("upstream Pi is told apart from Prime by its extension API or by SIEUN_CHAT_BACKEND", () => {
  assert.equal(onUpstreamPi({ on() {} }, {}), false);
  assert.equal(onUpstreamPi({ on() {}, registerMcpServer() {} }, {}), true);
  assert.equal(onUpstreamPi({ on() {} }, { SIEUN_CHAT_BACKEND: "pi-host" }), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { PRICES_SHARED_AS_CACHED } from "../scripts/clean-room/token-cost.ts";

test("token-cost clean room: a text that prices the shared instructions as cache reads counts, a price list with a cache-read column does not", () => {
  assert.match("The 1,863-token system prompt is billed at the $0.0069/1M cache-read rate, and only each bio's 120 tokens as fresh input.", PRICES_SHARED_AS_CACHED);
  assert.match("Shared instructions priced as cache reads; fresh input only for the bio.", PRICES_SHARED_AS_CACHED);
  assert.doesNotMatch("Wafer $0.07 in / $0.50 out / $0.0069 cache read.", PRICES_SHARED_AS_CACHED);
});

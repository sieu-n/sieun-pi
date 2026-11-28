import assert from "node:assert/strict";
import { test } from "node:test";
import { clientTimings, queryOf } from "../../server/request-log.ts";

// On 11-28 the pages around 10 Cmd K hits in one room logged as 10 reads of /api/c/ch_e6bd8de7/items, since `p` drops the query.
test("a line names its query's parameters in q, without their values", () => {
  assert.deepEqual(queryOf("/api/c/ch_e6bd8de7/items?around=p12"), { q: "around" });
  assert.deepEqual(queryOf("/api/search?q=board&limit=20&q=x"), { q: "q,limit" });
  assert.deepEqual(queryOf("/api/c/ch_e6bd8de7/items"), {});
  assert.deepEqual(queryOf(undefined), {});
});

test("a client line keeps a q of parameter names and drops any other q", () => {
  const [kept, dropped] = clientTimings({ samples: [
    { m: "GET", p: "/api/c/ch_e6bd8de7/items", q: "around", s: 200, ms: 230, bg: "ahead" },
    { m: "GET", p: "/api/search", q: "board words", s: 200, ms: 30 },
  ] });
  assert.equal(kept!.q, "around");
  assert.equal(dropped!.q, undefined);
});

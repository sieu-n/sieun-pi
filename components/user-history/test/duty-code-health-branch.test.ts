// Guards owner rule c119: us-metal02 moved from sieun/dev to dev/sieun on 2026-10-27 08:17Z, so the code health report reads its page module
// and its verify-dev push runs from dev/sieun, and keeps sieun/dev only for the runs from before that cutover.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_SUITES_SQL, PAGE_MODULE_REF } from "../scripts/duties/code-health-report.ts";

test("the code health report reads dev/sieun, and sieun/dev only for verify-dev runs from before the cutover", () => {
  assert.equal(PAGE_MODULE_REF, "origin/dev/sieun");
  assert.match(CI_SUITES_SQL, /AND head_branch IN \('dev\/sieun', 'sieun\/dev'\) AND completed_at > now\(\) - INTERVAL 8 DAY /);
});

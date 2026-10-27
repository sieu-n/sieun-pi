// Guards d7's CI cache line: from 11:23:57Z to 13:08:28Z on 10-20 every ci-cache cycle on us-metal02 failed with "fetch failed", and no d7 run
// said so; jobs asleep on promote run 39382235504 learned it from their wakes' errors and their time fallbacks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { parseBeat } from "../src/wakes.ts";

const RUN = Date.parse("2026-10-20T11:38:30Z");
const read = (beat: unknown) => measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], ciCache: parseBeat(beat) });

test("a CI cache with no good read for three of its cycles is a flagged line with its age, and a fresh one is only a metric", () => {
  const stale = read({ at: "2026-10-20T11:38:27Z", ok: false, error: "fetch failed", fetchedAt: "2026-10-20T11:23:16.497Z" });
  assert.equal(stale.metrics.ci_cache_age_s, 914);
  assert.match(stale.flagged?.find(slice => slice.kind === "ci_cache_stale")?.excerpt ?? "",
    /^The CI cache last read GitHub at 11:23Z, 15 min ago at a 30 s pace \(last cycle: fetch failed\)\. Run wakes read GitHub with gh run view/);
  const fresh = read({ at: "2026-10-20T11:38:20Z", ok: true, error: null, fetchedAt: "2026-10-20T11:38:16Z", intervalSeconds: 30 });
  assert.equal(fresh.metrics.ci_cache_age_s, 14);
  assert.equal(fresh.flagged?.some(slice => slice.kind === "ci_cache_stale"), false);
  assert.equal(measure({ now: RUN, watch: [], log: { holds: [] }, chats: [] }).metrics.ci_cache_age_s, undefined);
});

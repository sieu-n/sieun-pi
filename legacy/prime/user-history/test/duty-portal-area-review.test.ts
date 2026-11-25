// Guards the api-portal agent's Area review duty, its common daily duty of c249 (#sw-factory-build p234): it counts what the area holds that
// nobody acts on, red duties with no fix, steps nobody moved for 2 days, wiki pages stale or failing the prose lint, and unsaved corrections.
import assert from "node:assert/strict";
import { test } from "node:test";
import { review, STEP_UNMOVED_MS, type AreaInput } from "../scripts/duties/portal-area-review.ts";

const now = Date.parse("2026-11-26T00:00:00Z");
const base: AreaInput = { duties: [], plan: [], stuck: [], pages: [], state: { steps: {} }, now, shared: { metrics: { corrections_unsaved: 0 }, flagged: [] } };

test("a red duty counts only when no live job and no moving step links it, and the review's own duty and paused duties never count", () => {
  const out = review({ ...base,
    duties: [
      { duty: { id: "d2", name: "Portal matches crawler" }, paused: false, last: { verdict: "missed" },
        card: { misses: [{ key: "staging_working_pct", text: "staging 99.4%" }, { key: "routes_failing_portal", text: "1 route fails" }] } },
      { duty: { id: "d4", name: "Customer API failures" }, paused: false, last: { verdict: "missed" }, card: { headlineMiss: { key: "slow_route_p90_s" }, job: { live: true } } },
      { duty: { id: "d5", name: "Portal architecture" }, paused: false, last: { verdict: "error" }, card: {} },
      { duty: { id: "d6", name: "API status board" }, paused: true, last: { verdict: "missed" }, card: { headlineMiss: { key: "slow_endpoints_24h" } } },
      { duty: { id: "d7", name: "Area review" }, paused: false, last: { verdict: "missed" }, card: { headlineMiss: { key: "issues_not_acted_on" } } },
    ],
    plan: [
      { id: "p45", text: "fix the route", status: "doing", duty: "d2/routes_failing_portal" },
      { id: "p46", text: "stuck fix", status: "doing", duty: "d2/staging_working_pct" },
    ],
    stuck: ["p46"],
  });
  assert.equal(out.output.metrics.red_duties_unowned, 2);
  assert.deepEqual(out.output.flagged!.filter(slice => slice.kind === "red_duty_unowned").map(slice => slice.item), ["d2/staging_working_pct", "d5/error"]);
});

test("a stuck step counts after 2 days unchanged, by its updatedAt or else by the run that first saw it, and a change resets it", () => {
  const plan = [
    { id: "p1", text: "old stamped", status: "doing", updatedAt: new Date(now - STEP_UNMOVED_MS - 1).toISOString() },
    { id: "p2", text: "unstamped", status: "blocked", waitFor: "promote" },
    { id: "p3", text: "moving", status: "doing", updatedAt: new Date(now - 5 * STEP_UNMOVED_MS).toISOString() },
    { id: "p4", text: "done", status: "done" },
  ];
  const first = review({ ...base, plan, stuck: ["p1", "p2", "p4"] });
  assert.deepEqual(first.output.flagged!.filter(slice => slice.kind === "step_unmoved").map(slice => slice.item), ["p1"]);
  assert.deepEqual(Object.keys(first.state.steps), ["p1", "p2", "p3"]);
  const later = review({ ...base, plan, stuck: ["p1", "p2"], state: first.state, now: now + STEP_UNMOVED_MS });
  assert.equal(later.output.metrics.steps_unmoved_2d, 2);
  const changed = review({ ...base, plan: [plan[0]!, { ...plan[1]!, note: "promote asked" }], stuck: ["p1", "p2"], state: first.state, now: now + STEP_UNMOVED_MS });
  assert.equal(changed.output.metrics.steps_unmoved_2d, 1);
});

test("a wiki page counts once when its check is over 7 days old or it fails the lint, and the headline sums every part with the corrections", () => {
  const out = review({ ...base,
    pages: [
      { path: "agents/api-portal/identity.html", last_verified: null, updated: "2026-11-10", lintErrors: ["lead-visual x1"] },
      { path: "agents/api-portal/architecture.html", last_verified: "2026-11-25T20:22:29Z", lintErrors: [] },
      { path: "apps/api-portal/index.html", last_verified: "2026-11-25T12:17:58Z", lintErrors: ["doc-paragraph x5"] },
    ],
    shared: { metrics: { corrections_unsaved: 1 }, flagged: [{ kind: "area_review", excerpt: "x" }, { kind: "correction_unsaved", sig: "c1", excerpt: "c1: rule" }] },
  });
  assert.equal(out.output.metrics.wiki_pages_off, 2);
  assert.match(out.output.flagged!.find(slice => slice.item === "agents/api-portal/identity.html")!.excerpt, /last checked 2026-11-10; prose lint errors lead-visual x1/);
  assert.equal(out.output.metrics.issues_not_acted_on, 3);
  assert.deepEqual(out.output.flagged!.map(slice => slice.kind), ["area_review", "wiki_page_off", "wiki_page_off", "correction_unsaved"]);
  assert.equal(out.output.flagged![0]!.handOff, true);
});

test("with no shared review script the corrections read 0 and a flag says why", () => {
  const out = review({ ...base, shared: null });
  assert.equal(out.output.metrics.corrections_unsaved, 0);
  assert.ok(out.output.flagged!.some(slice => slice.kind === "shared_review_missing"));
});

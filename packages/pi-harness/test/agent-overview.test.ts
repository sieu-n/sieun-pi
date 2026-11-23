/**
 * A sw factory agent's refine sees the agent's own memory (seo, 11-20 21:31Z): with more than 40 global memories ahead of them, Prime's planner
 * overview listed none of the agent's entries, so two refines 14 s apart saved near copies of entries the agent already held.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { plannerPrompt, reviewPrompt } from "../src/core/refine.ts";
import { mergeStates, parseState } from "../src/core/store.ts";

const entry = (id: string, title: string) => ({ id, kind: "memory", title, content: `${title}.`, path: "test", version: 1 });
const store = (entries: ReturnType<typeof entry>[]) => ({ schema: 1, entries: { memory: Object.fromEntries(entries.map(e => [e.id, e])) }, refinements: [] });
const global = parseState(store(Array.from({ length: 758 }, (_, i) => entry(`global_${i}`, `Global note ${i}`))), "global");
const local = parseState(store([entry("request_window_via_aside", "Search Console request window sends only via Aside on the owner's Mac")]), "local");
const state = mergeStates(global, local);
const OWN = "[local:request_window_via_aside]";

test("an agent's planner and review gate list every entry of its memory ahead of the global store", () => {
  const planner = plannerPrompt(state, [], "conversation", { global: false, agent: "seo", routes: true });
  assert.ok(planner.includes(OWN), "the planner sees the agent's own entry");
  assert.ok(planner.indexOf(OWN) < planner.indexOf("[global:global_0]"));
  assert.match(planner, /- \+718 more memory entries/);
  assert.ok(reviewPrompt(state, [], "conversation", { reason: "turn_interval", turnsSinceLastReview: 25, agent: "seo" }).includes(OWN));
});

test("an agent's review shows only the local entries it is handed, in that order, and counts the rest; the planner still shows all", () => {
  const many = parseState(store(Array.from({ length: 60 }, (_, i) => entry(`own_${i}`, `Own note ${i}`))), "local");
  const both = mergeStates(global, many);
  const trigger = { reason: "turn_interval" as const, turnsSinceLastReview: 25, agent: "seo", localShown: ["memory:own_7", "memory:own_3"] };
  const review = reviewPrompt(both, [], "conversation", trigger);
  assert.ok(review.indexOf("[local:own_7]") < review.indexOf("[local:own_3]"), "the handed order holds");
  assert.ok(!review.includes("[local:own_0]"));
  assert.match(review, /- 2 of 60 local memory entries, the ones nearest the conversation/);
  assert.match(review, /memory: 818/);
  const planner = plannerPrompt(both, [], "conversation", { global: false, agent: "seo", routes: true });
  assert.ok(planner.includes("[local:own_0]") && planner.includes("[local:own_59]"), "the planner still sees every local entry");
});

test("outside an agent the overview keeps Prime's order and cap", () => {
  assert.ok(!plannerPrompt(state, [], "conversation", { global: false }).includes(OWN));
  assert.ok(!reviewPrompt(state, [], "conversation", { reason: "turn_interval", turnsSinceLastReview: 25 }).includes(OWN));
});

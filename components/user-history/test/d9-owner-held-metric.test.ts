// AI harness 10-24: d9's 11:25Z push told the chat that Skills and tools (d5) had no live owner on "d5/skills_or_tools_to_fix or
// d5/owner_fixes". owner_fixes was already held: its step p919 waited on For you t97, the owner's Apple sign-in of Codex fhnyq29tw5. Only
// skills_or_tools_to_fix 1, read by the 10:31Z run's after-job measure at 11:01Z, had no step. d9 names only the metric nobody owns, and its
// detail lists the metric that waits on the owner's todo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const at = (clock: string) => Date.parse(`2026-10-24T${clock}Z`);
const off = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const share = (value: number, target: number): MetricResult => ({ value, target, op: ">=", met: value >= target });
const p919: PlanItem = { id: "p919", text: "Codex account fhnyq29tw5 is signed back into the account pool and the Skills and tools check passes",
  status: "blocked", children: [], duty: "d5/owner_fixes", waitFor: "t97" };
const t97: OwnerTodo = { id: "t97", text: "Sign the Codex account fhnyq29tw5 back in: Settings, Accounts, Codex, Sign in again on fhnyq29tw5.",
  done: false, from: "agent", at: "2026-10-23T14:04:27.273Z" };
const board = (todo: OwnerTodo): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-24T11:00:00Z", plan: [p919], todos: [todo] });
const metrics = (skills: number) => ({ skills_or_tools_to_fix: off(skills), cache_read_ratio_1h: share(96.2, 90), cache_read_ratio_24h: share(95.3, 94), owner_fixes: off(1) });
/** The 10:31Z push run, whose job ended at 11:01Z with an after-job measure; `skills` is what that measure read. */
const run = (skills: number): DutyRunRecord => ({ duty: "d5", at: at("10:31:31"), trigger: "push", ms: 58_268, verdict: "missed", summary: "",
  metrics: metrics(0), job: { id: "01a16d78-1d27-749e-823f-e720ff76ef96", name: "skills and tools AI harness developer environment 19:31" },
  after: { at: at("11:01:13"), verdict: "missed", metrics: metrics(skills), summary: "" } });
const inputs = (skills: number, todo: OwnerTodo = t97): PlanInputs => ({ now: at("11:25:00"),
  chats: [{ id: HARNESS, name: "AI harness developer environment VP", runs: [run(skills)], duties: [{ id: "d5", name: "Skills and tools" }], everyMs: 120 * 60_000 }],
  boards: new Map([[HARNESS, board(todo)]]), ownerActivity: new Map(), waking: new Set(), poolWaiting: new Set(), named: new Map() });

test("d9 names only the metric nobody owns and lists the one that waits on the owner's todo", () => {
  const counts = planCounts(inputs(1));
  assert.equal(counts.redDuties.length, 1);
  assert.match(counts.redDuties[0]!.line, /\(duty field d5\/skills_or_tools_to_fix\) has a live owner now, while owner_fixes waits on the owner \(p919 on t97\)/);
  assert.doesNotMatch(counts.redDuties[0]!.line, /d5\/owner_fixes/);
  assert.deepEqual(counts.ownerHeld.map(entry => entry.line),
    ["AI harness developer environment VP: Skills and tools (d5) owner_fixes waits on the owner (p919 on t97), an open For you todo, so it owes no fix job"]);
});

test("a duty red only on the held metric is no stuck duty and still shows as waiting on the owner", () => {
  const counts = planCounts(inputs(0));
  assert.equal(counts.redDuties.length, 0);
  assert.equal(counts.ownerHeld.length, 1);
});

test("a live fix job on skills_or_tools_to_fix leaves no stuck duty, and owner_fixes still shows as waiting on t97", () => {
  const p1010: PlanItem = { id: "p1010", text: "Sign sieunpark77 back into pi-pool's Claude accounts", status: "doing", children: [], duty: "d5/skills_or_tools_to_fix",
    sessionId: "01a16daf-5418-734f-afd1-392e6e0f6dba" };
  const counts = planCounts({ ...inputs(1), boards: new Map([[HARNESS, { ...board(t97), plan: [p919, p1010] }]]),
    ownerActivity: new Map([["01a16daf-5418-734f-afd1-392e6e0f6dba", at("11:20:00")]]) });
  assert.equal(counts.redDuties.length, 0);
  assert.equal(counts.ownerHeld.length, 1);
});

test("once the owner answers t97, owner_fixes owes a fix again", () => {
  const counts = planCounts(inputs(0, { ...t97, done: true }));
  assert.equal(counts.ownerHeld.length, 0);
  assert.match(counts.redDuties[0]!.line, /\(duty field d5\/owner_fixes\) has a live owner now$/);
});

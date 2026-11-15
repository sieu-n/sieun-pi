// CI and RepoOps 11-15 04:27Z: p730's job field held the session id of the chat's live subagent "alerts 0406z batch", and three check-ins
// read the step as orphaned and stuck (job_ended) with "job 01a1dd6a-99c6-72bd-8708-3dff565cdf52 not found", because only names resolved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobFacts, ownerOf } from "../src/checkin-steps.ts";
import { stepSessions } from "../src/unmoved-steps.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

const SESSION = "01a1dd6a-99c6-72bd-8708-3dff565cdf52";
const batch = { id: "sub-alerts", label: "alerts 0406z batch", sessionName: "alerts 0406z batch", sessionId: SESSION, activeSessionId: "5e1f0c2a9b7d",
  status: "running" } as ChildAgent;
const step = (job: string, sessionId?: string): PlanItem =>
  ({ id: "p730", text: "CI alerts stop piling up", status: "doing", job, ...sessionId ? { sessionId } : {}, children: [] }) as unknown as PlanItem;
const boardOf = (item: PlanItem) => ({ plan: [item], todos: [] }) as unknown as ChatBoard;
const owner = (item: PlanItem, children: readonly ChildAgent[] = [batch]) => ownerOf(item, jobFacts(children, boardOf(item), [], "chat"));

test("a job field that holds a live subagent's session id resolves to that subagent, as its name does", () => {
  for (const item of [step(SESSION, SESSION), step(SESSION), step("alerts 0406z batch")]) {
    assert.equal(owner(item)?.name, "alerts 0406z batch", JSON.stringify(item));
    assert.equal(owner(item)?.state, "working");
  }
});

test("a job field that holds the subagent's active session id or an 8-character prefix of its session id resolves too", () => {
  assert.equal(owner(step("5e1f0c2a9b7d"))?.name, "alerts 0406z batch");
  assert.equal(owner(step("01a1dd6a"))?.name, "alerts 0406z batch");
  assert.equal(owner(step("01a1dd6a-99c6"))?.name, "alerts 0406z batch");
});

test("a prefix that two sessions share, or one shorter than 8 characters, names no job", () => {
  const twin: ChildAgent = { id: "sub-twin", label: "twin", sessionName: "twin", sessionId: "01a1dd6a-0000-7000-8000-000000000000", status: "running" };
  assert.equal(owner(step("01a1dd6a"), [batch, twin]), undefined);
  assert.equal(owner(step("01a1dd6a-99"), [batch, twin])?.name, "alerts 0406z batch");
  assert.equal(owner(step("01a1dd6")), undefined);
});

test("d9's step sessions take a job field that holds a session id prefix or an active session id listed as a name", () => {
  const named = new Map([["alerts 0406z batch", [SESSION]], ["5e1f0c2a9b7d", [SESSION]], ["twin", ["01a1dd00-0000-7000-8000-000000000000"]]]);
  assert.deepEqual(stepSessions({ job: SESSION }, named), [SESSION]);
  assert.deepEqual(stepSessions({ job: "01a1dd6a" }, named), [SESSION]);
  assert.deepEqual(stepSessions({ job: "5e1f0c2a9b7d" }, named), [SESSION]);
  assert.deepEqual(stepSessions({ job: "01a1dd" }, named), []);
});

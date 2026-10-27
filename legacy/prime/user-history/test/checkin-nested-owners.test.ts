// chat-057a 10-18 10:33Z: steps owned by working subagents of the chat's job read "job_ended", because the check-in looked only one level down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobFacts, nestedJobs } from "../src/checkin-steps.ts";
import type { ChatBoard, ChildAgent } from "../src/shared/types.ts";

const agent = (id: string, sessionId: string, status: ChildAgent["status"], label = id): ChildAgent =>
  ({ id, label, sessionName: label, sessionId, status } as ChildAgent);

test("a step owned by a working subagent of the chat's job reads working, not ended", () => {
  const runtime = agent("sub-runtime", "s-runtime", "done", "metal agent runtime");
  const isolation = agent("sub-iso", "s-iso", "running", "p8-test-isolation");
  const helper = agent("sub-helper", "s-helper", "running", "deep helper");
  const subagents = new Map<string, ChildAgent[]>([["chat", [runtime]], ["s-runtime", [isolation]], ["s-iso", [helper]]]);
  const nested = nestedJobs([], [runtime], subagents);
  assert.deepEqual(nested.map(child => child.id), ["sub-iso", "sub-helper"]);
  const board = { plan: [{ id: "p37", text: "Keep runtime tests away from live sessions", status: "doing", job: "p8-test-isolation", sessionId: "s-iso", children: [] }], todos: [] } as unknown as ChatBoard;
  const fact = jobFacts([runtime], board, [], "chat", nested).find(entry => entry.item?.id === "p37");
  assert.equal(fact?.state, "working");
});

test("duty jobs' subagents stay in, and a direct child is not listed twice", () => {
  const child = agent("sub-a", "s-a", "running");
  const subagents = new Map<string, ChildAgent[]>([["duty-1", [agent("sub-d", "s-d", "done")]], ["s-a", [child]]]);
  assert.deepEqual(nestedJobs(["duty-1"], [child], subagents).map(entry => entry.id), ["sub-d"]);
});

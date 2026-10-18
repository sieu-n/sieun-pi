import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyJobPriority, poolPriorities } from "../src/chat-pool-priority.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, name, kind: "live", archived: false, chat: false, priority: 0, origin: "agent", ...extra }) as SessionRow;
const root = (sessionId: string): ChatAgent => ({ key: "thread:" + sessionId, sessionId, name: sessionId, job: "session:" + sessionId, link: "root" }) as ChatAgent;

test("a check-in job runs in its chat's pool class and every other duty job stays low", () => {
  // 10-18 08:25Z to 11:05Z: check-in frontend bro 19:05 sat 58 min in pi-pool's slot wait as a low tree, while the runner skipped each slot.
  const rows = [
    row("chat-fe", "frontend bro", { chat: true, agents: [root("ck-fe"), root("d7-fe")] }),
    row("chat-ops", "ops guy (+observability)", { chat: true, priority: 2, agents: [root("ck-ops")] }),
    row("ck-fe", "check-in frontend bro 19:05"),
    row("ck-ops", "check-in ops guy (+observability) 19:26"),
    row("d7-fe", "whole system frontend bro 19:02"),
    row("ck-gone", "check-in archived chat 19:05"),
  ];
  const classes = poolPriorities(rows, new Set(["ck-fe", "ck-ops", "d7-fe", "ck-gone"]));
  assert.equal(classes.get("ck-fe"), "high");
  assert.equal(classes.get("ck-ops"), "normal");
  assert.equal(classes.get("d7-fe"), "low");
  assert.equal(classes.get("ck-gone"), "low", "a check-in job no loaded chat lists stays low");
  assert.equal(classes.get("chat-fe"), "high");
});

test("a duty job's first request carries the check-in's chat class or low", () => {
  assert.equal(dutyJobPriority("check-in frontend bro 19:05", "high"), "high");
  assert.equal(dutyJobPriority("whole system AI harness developer environment 19:02", "high"), "low");
  assert.equal(dutyJobPriority("alert frontend bro 19:05", "high"), "low");
});

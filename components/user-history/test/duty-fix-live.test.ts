// Guards Crawler VP's 07:13Z d1 run on 10-18: p364 named the job "census canary run" but kept the session id of the stopped pre-move copy, and
// fixJobLive read only that copy, so the run recorded no live fix while census canary run slept on a board.wake for 07:14:00Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixJobLive } from "../src/shared/duty-fixes.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

const chat = "01a115e2-9544-7204-b8db-8ce4d5319048";
const old = "01a12faa-591f-751e-b070-756c5697072e", live = "01a14d5d-b2f0-748c-9436-a3fa7b8bf129";
const agent = (fields: Partial<ChatAgent> & Pick<ChatAgent, "key" | "name">): ChatAgent =>
  ({ job: fields.name, sender: fields.name, link: "subagent", state: "done", steps: [], ...fields });
const row = (id: string, fields: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/", kind: "subagent", status: "idle", archived: true, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, ...fields } as SessionRow);
const rows = [
  row(chat, { agents: [
    agent({ key: "child:sub-6e95e67b", name: "census canary run", sessionId: live, state: "idle" }),
    agent({ key: "thread:" + old, name: "census canary run before move", sender: "census canary run before move", sessionId: old, steps: ["p364"] }),
  ] }),
  row(old), row(live),
];
const step = { id: "p364", job: "census canary run", sessionId: old };

test("a fix step's named job asleep on a board.wake is live though the step keeps an old session id", () => {
  const now = Date.parse("2026-10-18T07:13:30Z");
  assert.equal(fixJobLive(step, chat, rows, new Set([live]), new Set(), now), true);
  assert.equal(fixJobLive(step, chat, rows, new Set(), new Set(), now), false, "no session the step names sleeps, works or waits");
  assert.equal(fixJobLive(step, chat, rows, new Set(), new Set([live]), now), true, "the named job holds a place in pi-pool's queue");
});

// 10-27 07:03Z: d9's run read sep launch!!'s p106 to p108 job "live search prod reads" (01a17c2c-a7f7) as gone, since us-metal02's copy of the
// Mac's catalog did not list it yet, and its job started a second job for those steps. That job was the chat's own Mac subagent, made at 07:04Z
// for d9's push and active until 08:19Z. A job d9 cannot see, on a box it cannot reach or missing from a lagging copy, is unknown, not gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, downRoutes, ownerUnknown, unknownOwners } from "../scripts/duties/chat-system.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const JOB = "01a17c2c-a7f7-743c-84bb-53aa2f4d3e55";
const step = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text: `step ${id}`, status: "todo", children: [], ...extra });
const plan = [step("p104", { children: [step("p106", { job: "live search prod reads", sessionId: JOB, waitFor: "the next prod promote (p980)" }),
  step("p107", { job: "live search prod reads" }), step("p110", { job: "local job", sessionId: "local-1" }), step("p111")] })];
const board = { v: 2, rev: 1, updatedAt: "2026-10-27T06:20:00Z", todos: [], plan } as unknown as ChatBoard;
const chatRow = { sessionId: SEP, sessionName: "sep launch!!", sessionFile: `/Users/sieunpark/.prime/agent/sessions/${SEP}.jsonl` };
const localRow = { sessionId: "local-1", sessionName: "local job", sessionFile: "/home/sieun/.prime/agent/sessions/local-1.jsonl", lastActivityAt: "2026-10-27T01:00:00Z" };
const reads = { boards: new Map([[SEP, board]]), named: new Map(), rows: [chatRow, localRow], chats: new Set([SEP]), cancelled: new Set<string>(),
  hostOf: new Map<string, string | null>([[SEP, "mac"], ["local-1", null]]), away: new Set<string>(), dataDir: "/data" };
const stuck = ["p106", "p107", "p110", "p111"].map(id => ({ chat: SEP, id, text: `step ${id}` }));

test("a Mac chat's step whose job no catalog copy lists yet has an unknown owner, and d9 moves it to no new job even when the chat is down", () => {
  const item = (id: string) => plan[0]!.children.find(entry => entry.id === id)!;
  assert.equal(ownerUnknown(item("p106"), SEP, reads), `its job ${JOB} is not in this box's copy of mac's catalog, which lists a new session or subagent of a chat there late`);
  assert.match(ownerUnknown(item("p107"), SEP, reads) ?? "", /^its job live search prod reads is not in/);
  assert.equal(ownerUnknown(item("p110"), SEP, reads), undefined, "a job this box lists and reaches is known");
  assert.equal(ownerUnknown(item("p111"), SEP, reads), undefined, "a step with no job names no owner to wait for");
  assert.match(ownerUnknown(item("p106"), SEP, { ...reads, away: new Set(["mac"]) }) ?? "", /belongs to a chat on mac, which Tailscale reads offline$/);
  const routes = downRoutes(stuck, new Set([SEP]), reads, () => "sep launch!!");
  assert.deepEqual(routes.moves.map(move => move.id), ["p111"]);
  assert.deepEqual(routes.pushes.map(push => [push.session, push.steps.map(entry => entry.id)]), [["local-1", ["p110"]]]);
});

test("the precheck flags each step with an unknown owner, so the run's job starts no job in its place", () => {
  const unknown = unknownOwners(stuck, reads);
  assert.deepEqual(unknown.map(entry => entry.id), ["p106", "p107"]);
  const out = chatSystemOutput({ names: new Map([[SEP, "sep launch!!"]]), stuck, upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [],
    followUps: [], detail: "/tmp/d9.md", unknownOwners: unknown });
  const slices = out.flagged!.filter(slice => slice.kind === "owner_unknown");
  assert.deepEqual(slices.map(slice => slice.item), ["p106", "p107"]);
  assert.match(slices[0]!.excerpt, /^sep launch!!: p106 "step p106" is stuck, and its job 01a17c2c-.* so d9 reads its owner as unknown, not gone\. Start no job in its place/);
  assert.equal(out.metrics.stuck_steps_all, 4, "an unknown owner still counts until its step moves");
});

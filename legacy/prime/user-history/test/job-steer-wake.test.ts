import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, SessionRow } from "../src/shared/types.ts";
import type { Wake } from "../src/wakes.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

// VP of CI on 10-18: the 12:00Z check-in told "repo design count" to attack p75, and the message waited for its 19:50Z board.wake, 7.5 h away.
test("a check-in's message reaches a job asleep on a time wake or a CI run wake at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-steer-wake-"));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const now = Date.parse("2026-10-18T12:12:00Z");
  const agent = (sessionId: string, name: string): ChatAgent =>
    ({ key: `child:sub-${sessionId}`, sessionId, childId: `sub-${sessionId}`, name, job: name, sender: name, link: "subagent", state: "done",
      lastActivityAt: new Date(now - 60_000).toISOString(), steps: [] });
  const agents = [agent("j1", "repo design count"), agent("j2", "ci watcher")];
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents })];
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p75", text: "Monorepo and GitHub Actions are designed right", status: "doing", children: [
    { id: "p263", text: "Push: open repo design review problems reach 0", status: "doing", job: "repo design count", sessionId: "j1", duty: "checkin/goal_gaps", children: [] },
    { id: "p264", text: "Watch the CI run", status: "doing", job: "ci watcher", sessionId: "j2", children: [] }] }] };
  const wakes: Wake[] = [
    { session: "j1", on: { kind: "time", at: Date.parse("2026-10-18T19:50:00Z") }, note: "check the review", since: now - 60_000 },
    { session: "j2", on: { kind: "run", run: 39080016700 }, note: "read the run", since: now - 60_000 }];
  const threads = fakeThreads(calls);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now, rows), wakes: async () => wakes });
  await chats.adopt();
  threads.fire().children("c1", agents.map(entry => ({ id: entry.childId!, label: entry.name, sessionName: entry.name, sessionId: entry.sessionId!, status: "done" as const, lastActivityAt: now - 60_000 })));
  calls.length = 0;
  assert.deepEqual(await chats.steerJob("c1", "repo design count", "attack p75's biggest blocker now"), { session: "j1", act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", "j2", "the run is red, fix it"), { session: "j2", act: "steer" });
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [
    "steer j1 [check-in] attack p75's biggest blocker now",
    "steer j2 [check-in] the run is red, fix it"]);
  chats.close();
});

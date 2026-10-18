import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { inSidebar, originOf } from "../src/client/organize.ts";
import { asleepAt } from "../scripts/clean-room/checkin-push-control.ts";
import { newerReading } from "../src/shared/chat-board.ts";
import { looksDone, NO_FACTS } from "../src/checkin-done.ts";

test("a clean-room test chat is agent-created, so the owner's sidebar and For you count leave it out (r3c, 10-18 02:10Z)", async () => {
  const linkedin = "01a14c62-6999-715e-9a56-31ad0bd5fb59", harness = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  const index = (ids: string[]) => ({ ids: async () => ids });
  // Both chats are in chats.json and threads.json, as POST api/threads files every chat; only the clean-room file tells them apart.
  const origins = new ThreadOrigins(index([linkedin, harness]), index([linkedin]));
  const originOfRow = await origins.resolver(new Set([linkedin, harness]));
  assert.equal(originOfRow({ sessionId: linkedin }), "agent");
  assert.equal(originOfRow({ sessionId: harness }), "user");
  assert.equal((await new ThreadOrigins(index([linkedin])).resolver(new Set([linkedin])))({ sessionId: linkedin }), "user", "with no clean-room index it stays the person's");
  const row = (id: string) => ({ id, origin: originOfRow({ sessionId: id }), archived: false, chat: true } as unknown as Parameters<typeof inSidebar>[0]);
  assert.equal(originOf(row(linkedin)), "agent");
  assert.equal(inSidebar(row(linkedin), { archived: false, agentCreated: false }), false);
  assert.equal(inSidebar(row(harness), { archived: false, agentCreated: false }), true);
});

test("push-control (2) leaves a job asleep on an owed board.wake alone, and counts it again once its [wake] arrives (r3c linkedin post fix)", () => {
  const at = (time: string) => Date.parse(`2026-10-18T${time}Z`);
  const events = [
    { kind: "call" as const, at: at("00:51:19"), tool: "ipython", input: "board.wake(run=39084232774, note='land on green')" },
    { kind: "assistant" as const, at: at("00:52:55"), text: "Waiting on the run." },
  ];
  assert.equal(asleepAt(events, at("01:04:55")), true);
  assert.equal(asleepAt([...events, { kind: "text" as const, at: at("02:20:00"), role: "custom" as const, text: "[wake] run 39084232774 finished" }], at("02:37:05")), false);
  assert.equal(asleepAt(events.slice(1), at("01:04:55")), false, "no wake set");
});

test("a kept reading stamped after the write is no newer than the job's later real count (r3c p1, 10-18 00:42Z)", () => {
  const kept = { metric: "top gaps measured", target: 10, unit: "gaps", current: 2, measuredAt: "2026-10-18T00:45:00.000Z", source: "chat" };
  const next = { ...kept, current: 3, measuredAt: "2026-10-18T00:42:27.000Z", source: "job" };
  assert.deepEqual(newerReading(next, kept, "2026-10-18T00:42:30.000Z"), next);
  assert.deepEqual(newerReading(next, kept, "2026-10-18T00:46:00.000Z"), { ...next, current: 2, measuredAt: kept.measuredAt, source: "chat" }, "past the stamp, the newer reading still wins");
});

test("a fix step whose wait names an unlanded CI run is not finished because its metric met meanwhile (AI harness p564, 10-18)", () => {
  const facts = { ...NO_FACTS, metrics: new Map([["d7/queue_holds_30", { value: 0, target: 0, op: "<=" as const, met: true, missedAt: Date.parse("2026-10-18T01:43:00Z"), at: Date.parse("2026-10-18T02:44:00Z") }]]) };
  const p564 = { id: "p564", text: "Rate-limit holds stop counting as queue holds", status: "doing" as const, duty: "d7/queue_holds_30", waitFor: "probe run 39090428684 lands green" };
  assert.equal(looksDone(p564, facts as never), null);
  assert.notEqual(looksDone({ text: p564.text, status: p564.status, duty: p564.duty }, facts as never), null, "with no run in its wait the met metric still closes it");
});

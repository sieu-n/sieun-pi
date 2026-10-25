// chat-2572 p20 on 10-25: clean-room setups gave the head its first message at create, before fixtures and the board seed existed, so its
// first turn could race the seed. Deferred admission creates the chat empty with its check-in paused and admits the head last. This guards the
// order against a fake chat service: no model turn and no scheduled check-in before setup ends, and a lost prompt answer neither sends the task
// twice nor reseeds an admitted head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { admit, type AdmissionIo, type AdmissionState } from "../scripts/clean-room/deferred-admission.ts";

/** A chat service that runs a model turn on each delivered message and a check-in on each tick while the chat is not paused and has a board. */
function service(options: { loseAnswer?: number } = {}) {
  const events: string[] = [];
  let clock = Date.parse("2026-10-25T02:00:00Z");
  let paused = false;
  let rev = 0;
  const messages: string[] = [];
  let answers = 0;
  let saved: AdmissionState | undefined;
  const tick = () => { if (!paused && rev > 0) events.push("check-in"); };
  const io: AdmissionIo = {
    async createEmpty() { events.push("create"); tick(); return "01a17000-0000-7000-8000-0000000000aa"; },
    async pauseCheckIn() { paused = true; events.push("pause"); },
    async makeFixtures() { events.push("fixtures"); tick(); return { "archive shelf count": "01a17000-0000-7000-8000-0000000000bb" }; },
    async seed() { rev += 1; events.push(`seed rev ${rev}`); tick(); return rev; },
    async firstMessage(_chat, requestId) { return messages.length === 0 ? "none" : messages[0] === requestId ? "this" : "other"; },
    async deliver(_chat, requestId) {
      messages.push(requestId);
      events.push("turn");
      answers += 1;
      if (options.loseAnswer === answers) throw new Error("socket hang up after the prompt was accepted");
    },
    async resumeCheckIn() { paused = false; events.push("resume"); tick(); },
    save(state) { saved = structuredClone(state); },
    now() { clock += 1000; return clock; },
  };
  return { io, events, messages, saved: () => saved!, external: (requestId: string) => messages.push(requestId) };
}

test("deferred admission: the head's first turn and the first check-in come only after the fixtures and the seed", async () => {
  const fake = service();
  const state = await admit({ requestId: "r-1", order: [] }, fake.io);
  assert.deepEqual(fake.events, ["create", "pause", "fixtures", "seed rev 1", "turn", "resume", "check-in"]);
  assert.deepEqual(state.order.map(entry => entry.step), ["created", "paused", "fixtures", "seeded", "delivered", "resumed"]);
  assert.ok(state.order.every((entry, index) => index === 0 || entry.at > state.order[index - 1]!.at), "each step has its own time, in order, never backdated");
  assert.deepEqual(fake.messages, ["r-1"]);
});

test("deferred admission: a lost answer after the prompt was accepted neither sends the task twice nor reseeds", async () => {
  const fake = service({ loseAnswer: 1 });
  const state = await admit({ requestId: "r-2", order: [] }, fake.io);
  assert.deepEqual(fake.messages, ["r-2"], "the session held the message, so the lost answer was not sent again");
  const again = await admit(structuredClone(fake.saved()), fake.io);
  assert.deepEqual(fake.messages, ["r-2"], "a setup run again after it finished sends nothing");
  assert.equal(fake.events.filter(event => event.startsWith("seed")).length, 1, "and seeds nothing");
  assert.deepEqual(again.order, state.order);
});

test("deferred admission: a crash after delivery resumes without a reseed, and an admitted head with no seed is refused", async () => {
  const fake = service();
  const crashed: AdmissionState = { requestId: "r-3", order: [] };
  const io: AdmissionIo = { ...fake.io, resumeCheckIn: async () => { throw new Error("service restarted"); } };
  await assert.rejects(admit(crashed, io));
  const resumed = await admit(structuredClone(fake.saved()), fake.io);
  assert.equal(fake.events.filter(event => event.startsWith("seed")).length, 1);
  assert.deepEqual(fake.messages, ["r-3"]);
  assert.equal(resumed.order.at(-1)?.step, "resumed");

  const raced = service();
  raced.external("r-4");
  await assert.rejects(admit({ requestId: "r-4", order: [{ step: "created", at: 1 }, { step: "paused", at: 2 }], chat: "01a17000-0000-7000-8000-0000000000aa" }, raced.io),
    /got its first message before its board was seeded/);
  const foreign = service();
  foreign.external("someone else");
  await assert.rejects(admit({ requestId: "r-5", order: [] }, foreign.io), /first message this setup did not send/);
  assert.ok(!foreign.events.some(event => event.startsWith("seed")), "a chat someone else wrote to is never seeded");
});

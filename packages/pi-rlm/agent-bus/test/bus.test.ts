import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import * as registry from "@sieun-pi/pi-family/registry";
import { MAX_MESSAGE_CHARS } from "../src/limits.ts";
import { sendFromClient } from "../src/route.ts";
import { pendingCount, repliedSinceTask } from "../src/state.ts";
import { landed, openAgent, until, type Opened } from "./rig.ts";

let root: string;
let A: Opened, B: Opened, C: Opened, D: Opened;

const call = (who: Opened, method: string, payload: Record<string, unknown> = {}) => {
  const handler = kernelHandler(who.id, method);
  assert.ok(handler, `${method} is registered for ${who.id}`);
  return Promise.resolve(handler(payload)) as Promise<any>;
};
const idle = (who: Opened) => until(() => !who.runtime.session.isStreaming, 20_000, "idle");

before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-bus-"));
  A = await openAgent(root, "A");
  B = await openAgent(root, "B");
  C = await openAgent(root, "C", { role: "child", parentId: A.id, depth: 1 });
  D = await openAgent(root, "D", { role: "child", parentId: A.id, depth: 1 });
});

after(async () => {
  for (const s of [A, B, C, D]) await s?.runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

test("a child's reply lands in the parent as Prime's labeled custom message and marks repliedSinceTask", async () => {
  const receipt = await call(C, "agent_message.send", { message: "  done, see /tmp/x  ", receiver_role: "parent" });
  assert.equal(receipt.deliveryStatus, "delivered");
  assert.equal(receipt.deliveryMode, "steer");
  assert.equal(receipt.message, "done, see /tmp/x");
  assert.match(receipt.id, /^agentmsg_/);
  assert.equal(receipt.from.sessionName, "C");
  assert.equal(receipt.from.runtimeKind, "subagent");
  assert.equal(receipt.from.clientId, "agent");
  assert.equal(receipt.target.sessionId, A.id);
  assert.ok(receipt.deliveredAt);
  await until(() => landed(A.file()).some(m => m.id === receipt.id));
  const got = landed(A.file()).find(m => m.id === receipt.id)!;
  assert.equal(got.header, "[agent-message from child:C]");
  assert.equal(got.message, "done, see /tmp/x");
  assert.equal(repliedSinceTask(C.id), true);
  await idle(A);
  await call(A, "agent_message.send", { message: "next task", receiver_role: "child", receiver_name: "C" });
  assert.equal(repliedSinceTask(C.id), false);
  await until(() => landed(C.file()).some(m => m.header === "[agent-message from parent:A]"));
  await idle(C);
});

test("roots are siblings, children of one parent are siblings, and anything else is out of reach", async () => {
  const toB = await call(A, "agent_message.send", { message: "root to root", receiver_role: "sibling", receiver_name: "B" });
  assert.equal(toB.target.sessionName, "B");
  await until(() => landed(B.file()).some(m => m.header === "[agent-message from sibling:A]"));
  const toD = await call(C, "agent_message.send", { message: "sib", receiver_role: "sibling", receiver_name: D.id });
  assert.equal(toD.target.sessionName, "D");
  await assert.rejects(call(C, "agent_message.send", { message: "x", receiver_role: "sibling", receiver_name: "B" }), /No sibling matches "B"/);
  await assert.rejects(call(B, "agent_message.send", { message: "x", receiver_role: "parent" }), /No parent matches the current agent/);
  await assert.rejects(call(A, "agent_message.send", { message: "x", receiver_role: "cousin" }), /receiver_role must be/);
  await assert.rejects(call(A, "agent_message.send", { message: "x", receiver_role: "child" }), /receiver_name is required/);
  await assert.rejects(call(C, "agent_message.send", { message: "x", receiver_role: "parent", receiver_name: "A" }), /must be omitted/);
  await assert.rejects(call(A, "agent_message.send", { message: "   ", receiver_role: "child", receiver_name: "C" }), /cannot be empty/);
  await assert.rejects(call(A, "agent_message.send", { message: "x", target: "B" }), /positional/);
  for (const s of [A, B, C, D]) await idle(s);
});

test("broadcast to all returns one receipt per family member in roster order", async () => {
  const out = await call(A, "agent_message.send", { message: "hello family", target: "all" });
  assert.deepEqual(out.receipts.map((r: any) => r.target.sessionName), ["B", "C", "D"]);
  for (const s of [B, C, D]) await until(() => landed(s.file()).some(m => m.message === "hello family"));
  for (const s of [A, B, C, D]) await idle(s);
});

test("a busy receiver gets a steer after its tool and a follow-up after its run, and pending counts drop to zero", async () => {
  const run = B.runtime.session.prompt("busy 1500");
  await until(() => B.runtime.session.isStreaming);
  await new Promise(resolve => setTimeout(resolve, 200));
  const steer = await call(A, "agent_message.send", { message: "steer me", receiver_role: "sibling", receiver_name: "B", mode: "steer" });
  const follow = await call(A, "agent_message.send", { message: "after the run", receiver_role: "sibling", receiver_name: "B", mode: "follow_up" });
  assert.equal(steer.deliveryStatus, "queued");
  assert.ok(steer.queuedAt);
  assert.equal(follow.deliveryStatus, "queued");
  assert.equal(follow.deliveryMode, "follow_up");
  assert.equal(pendingCount(B.id), 2);
  await run;
  await idle(B);
  const messages = B.runtime.session.messages as any[];
  const at = (id: string) => messages.findIndex(m => m.role === "custom" && m.details?.id === id);
  const toolResult = messages.findIndex(m => m.role === "toolResult");
  assert.ok(toolResult >= 0 && at(steer.id) > toolResult, "the steer lands after the tool result");
  assert.ok(at(follow.id) > at(steer.id) + 1, "the follow-up lands after the steer's answer");
  assert.equal(pendingCount(B.id), 0);
});

test("the size, pending and rate limits are soft caps that flag the receipt and still deliver", async () => {
  const big = "x".repeat(MAX_MESSAGE_CHARS + 10);
  const r = await call(A, "agent_message.send", { message: big, receiver_role: "sibling", receiver_name: "B" });
  assert.ok(r.overLimit?.some((s: string) => s.includes(`${MAX_MESSAGE_CHARS + 10} chars`)));
  const burst = [];
  for (let i = 0; i < 4; i += 1) burst.push(await call(A, "agent_message.send", { message: `burst ${i}`, receiver_role: "sibling", receiver_name: "B" }));
  assert.ok(burst.some(x => x.overLimit?.some((s: string) => s.includes("messages a second"))));
  await until(() => landed(B.file()).filter(m => m.message.startsWith("burst ")).length === 4);
  await idle(B);
});

test("a client send has no relationship in its header, and a send that names a sender keeps the reach rule", async () => {
  const r = await sendFromClient({ target: B.id, message: "from the chat", clientId: "chat" });
  assert.equal(r.from.sessionName, "chat");
  await until(() => landed(B.file()).some(m => m.message === "from the chat" && m.header === "[agent-message from chat]"));
  const byName = await sendFromClient({ target: "B", message: "by name", from: { id: A.id } });
  assert.equal(byName.target.sessionId, B.id);
  await assert.rejects(sendFromClient({ target: C.id, message: "x", from: { id: B.id } }), /Agent reach is limited/);
  await idle(B);
});

test("agent_observe lists the family with Prime's fields and returns bounded previews", async () => {
  const list = await call(C, "agent_observe.list");
  assert.equal(list.current.sessionName, "C");
  assert.equal(list.current.isCurrent, true);
  assert.deepEqual(list.agents.map((a: any) => [a.relationship, a.sessionName]), [["parent", "A"], ["sibling", "D"]]);
  const parent = list.agents[0];
  assert.equal(parent.status, "idle");
  assert.equal(parent.isSessionActive, true);
  assert.equal(parent.runtimeKind, "top-level");
  assert.ok(parent.latestMessage.text.length <= 240);
  const fromA = await call(A, "agent_observe.list");
  const c = fromA.agents.find((a: any) => a.sessionName === "C");
  assert.equal(c.relationship, "child");
  assert.equal(typeof c.repliedSinceTask, "boolean");
  assert.equal(c.parentSessionId, A.id);
  const recent = await call(A, "agent_observe.recent", { target: "C", limit: 2, max_chars: 80 });
  assert.equal(recent.messages.length, 2);
  assert.ok(recent.messages.every((m: any) => m.text.length <= 80 && typeof m.index === "number"));
  assert.equal(recent.limit, 2);
  assert.equal(recent.maxChars, 80);
  const got = await call(A, "agent_observe.get", { target: C.id.slice(-8) });
  assert.equal(got.agent.sessionName, "C");
  await assert.rejects(call(A, "agent_observe.recent", { target: "C", limit: 51 }), /between 1 and 50/);
  await assert.rejects(call(A, "agent_observe.recent", { target: "C", max_chars: 10 }), /between 80 and 2000/);
  await assert.rejects(call(C, "agent_observe.get", { target: "B" }), /Agent reach is limited|No agent matches/);
});

test("a closed child shows as inactive, reads from its file, and wakes on a send", async () => {
  const file = D.file()!;
  const id = D.id;
  await D.runtime.dispose();
  assert.equal(registry.get(id), undefined);
  let woke = 0;
  registry.registerDormant({
    id, name: "D", role: "child", parentId: A.id, depth: 1, cwd: join(root, "ws"), sessionFile: file,
    wake: async () => {
      woke += 1;
      D = await openAgent(root, "D", { role: "child", parentId: A.id, depth: 1 }, file);
      return registry.get(id)!;
    },
  });
  const list = await call(A, "agent_observe.list");
  const d = list.agents.find((a: any) => a.sessionName === "D");
  assert.equal(d.status, "inactive");
  assert.equal(d.isSessionActive, false);
  assert.equal(d.activeSessionId, undefined);
  assert.ok(d.firstMessage);
  const recent = await call(A, "agent_observe.recent", { target: "D", limit: 3 });
  assert.ok(recent.messages.length > 0);
  const r = await call(A, "agent_message.send", { message: "wake up", receiver_role: "child", receiver_name: "D" });
  assert.equal(woke, 1);
  assert.equal(r.target.sessionId, id);
  await until(() => landed(D.file()).some(m => m.message === "wake up"));
  await idle(D);
  registry.unregisterDormant(id);
});

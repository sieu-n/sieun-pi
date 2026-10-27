import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { kernelHandler } from "../../shared/kernel-bridge.ts";
import * as registry from "../../shared/registry.ts";
import { inboxDir, records } from "../src/inbox.ts";
import { sendFromClient } from "../src/route.ts";
import { landed, openAgent, until, type Opened } from "./rig.ts";

let root: string;
let A: Opened;

const send = (from: Opened, to: string, message: string, mode = "steer") =>
  Promise.resolve(kernelHandler(from.id, "agent_message.send")!({ message, receiver_role: "sibling", receiver_name: to, mode })) as Promise<{ id: string; deliveryStatus: string }>;
const idle = (s: Opened) => until(() => !s.runtime.session.isStreaming, 30_000, "idle");
const inboxFile = (id: string) => join(inboxDir(), `${id}.jsonl`);

before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-bus-inbox-test-"));
  A = await openAgent(root, "A");
});

after(async () => {
  await A.runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function busyWithQueue(name: string, count: number): Promise<{ s: Opened; ids: string[]; run: Promise<unknown> }> {
  const s = await openAgent(root, name);
  const run = s.runtime.session.prompt("busy 5000").catch(() => undefined);
  await until(() => s.runtime.session.isStreaming);
  await new Promise(resolve => setTimeout(resolve, 100));
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = await send(A, name, `${name} queued ${i}`, i % 3 === 2 ? "follow_up" : "steer");
    assert.equal(r.deliveryStatus, "queued");
    ids.push(r.id);
  }
  assert.equal(records(s.id).length, count, "every queued message is on disk before Pi holds it");
  return { s, ids, run };
}

function assertOnce(file: string | undefined, ids: string[]): void {
  const got = landed(file).map(m => m.id);
  for (const id of ids) assert.equal(got.filter(x => x === id).length, 1, `${id} landed once`);
}

test("messages queued in a receiver that is killed mid-run land once when it reopens", async () => {
  const { s, ids, run } = await busyWithQueue("K", 6);
  const file = s.file()!;
  await s.runtime.dispose();
  await run;
  assert.equal(registry.get(s.id), undefined);
  const before = landed(file).map(m => m.id);
  assert.ok(ids.some(id => !before.includes(id)), "the kill dropped queued messages from memory");
  const again = await openAgent(root, "K", undefined, file);
  assert.equal(again.id, s.id);
  await until(() => ids.every(id => landed(file).some(m => m.id === id)), 30_000, "replay");
  await idle(again);
  assertOnce(file, ids);
  await until(() => !existsSync(inboxFile(s.id)), 5_000, "inbox removed");
  await again.runtime.dispose();
});

test("an abort keeps queued messages, the next run delivers them once, and the inbox empties", async () => {
  const { s, ids, run } = await busyWithQueue("Q", 4);
  await s.runtime.session.abort();
  await run;
  await idle(s);
  assert.ok(records(s.id).length > 0, "unlanded messages stay on disk after the abort");
  const next = await send(A, "Q", "Q after abort");
  await until(() => [...ids, next.id].every(id => landed(s.file()).some(m => m.id === id)), 30_000, "drain");
  await idle(s);
  assertOnce(s.file(), [...ids, next.id]);
  await until(() => !existsSync(inboxFile(s.id)), 5_000, "inbox removed");
  await s.runtime.dispose();
});

test("an abort followed by a kill still lands every queued message once after the reopen", async () => {
  const { s, ids, run } = await busyWithQueue("AK", 5);
  const file = s.file()!;
  await s.runtime.session.abort();
  await run;
  await s.runtime.dispose();
  const again = await openAgent(root, "AK", undefined, file);
  await until(() => ids.every(id => landed(file).some(m => m.id === id)), 30_000, "replay");
  await idle(again);
  assertOnce(file, ids);
  await again.runtime.dispose();
});

test("a reopen with nothing queued sends nothing", async () => {
  const s = await openAgent(root, "N");
  await send(A, "N", "plain");
  await until(() => landed(s.file()).length === 1);
  await idle(s);
  const file = s.file()!;
  await s.runtime.dispose();
  const again = await openAgent(root, "N", undefined, file);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(landed(file).length, 1);
  assert.equal(again.runtime.session.isStreaming, false);
  await again.runtime.dispose();
});

test("a keyed client send that repeats lands once, also after the receiver is killed and reopened", async () => {
  const s = await openAgent(root, "I");
  const first = await sendFromClient({ target: s.id, message: "keyed once", clientId: "chat", idempotencyKey: "chat:cmd-1" });
  const again = await sendFromClient({ target: s.id, message: "keyed once", clientId: "chat", idempotencyKey: "chat:cmd-1" });
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  assert.equal(again.deliveryStatus, first.deliveryStatus);
  await until(() => landed(s.file()).some(m => m.id === first.id));
  await idle(s);
  const other = await sendFromClient({ target: s.id, message: "keyed twice", clientId: "chat", idempotencyKey: "chat:cmd-2" });
  assert.notEqual(other.id, first.id);
  await until(() => landed(s.file()).some(m => m.id === other.id));
  await idle(s);
  const file = s.file()!;
  await s.runtime.dispose();
  const reopened = await openAgent(root, "I", undefined, file);
  const late = await sendFromClient({ target: s.id, message: "keyed once", clientId: "chat", idempotencyKey: "chat:cmd-1" });
  assert.equal(late.id, first.id);
  assert.equal(late.duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assertOnce(file, [first.id, other.id]);
  assert.equal(landed(file).length, 2);
  await reopened.runtime.dispose();
});

test("a keyed send that is only queued when the receiver dies is not repeated by a retry after the reopen", async () => {
  const s = await openAgent(root, "J");
  const run = s.runtime.session.prompt("busy 5000").catch(() => undefined);
  await until(() => s.runtime.session.isStreaming);
  const first = await sendFromClient({ target: s.id, message: "queued keyed", clientId: "chat", idempotencyKey: "chat:q-1" });
  assert.equal(first.deliveryStatus, "queued");
  const file = s.file()!;
  await s.runtime.dispose();
  await run;
  assert.ok(!landed(file).some(m => m.id === first.id), "the kill dropped it from memory");
  const reopened = await openAgent(root, "J", undefined, file);
  const retry = await sendFromClient({ target: s.id, message: "queued keyed", clientId: "chat", idempotencyKey: "chat:q-1" });
  assert.equal(retry.id, first.id);
  assert.equal(retry.duplicate, true);
  await until(() => landed(file).some(m => m.id === first.id), 30_000, "replay");
  await idle(reopened);
  assertOnce(file, [first.id]);
  await reopened.runtime.dispose();
});

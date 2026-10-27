// Guards the 10-22 messaging audit's lost notices: chat check-in and job notices went straight to the daemon once, and 12 that failed from 10-19
// 07:00Z to 10-22 08:00Z were logged and never sent again (sieun-pi chats.ts `tell`). They now wait on disk in the notice outbox until they land.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { heldNoticeRecord } from "../src/chat-sources.ts";
import { ThreadError, type ThreadHub } from "../src/chat-threads.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { noticeOutbox } from "../src/notice-outbox.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";

test("a check-in notice whose steer fails goes again until it lands, and a chat the daemon no longer has fails it for good", async t => {
  const dir = await mkdtemp(join(tmpdir(), "notice-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const lines: string[] = [];
  const failures = ["Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\"", "Daemon is preparing an update restart"];
  const hub = { ...fakeThreads(calls),
    async prompt(id: string, input: { message: string; mode: string; sending?: () => Promise<void> }) {
      calls.push(`${input.mode} ${id} ${input.message}`);
      if (id === "gone") throw new ThreadError(404, "Thread not found.");
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      await input.sending?.();
    },
    copyOf: async () => "absent" as const };
  const notices = noticeOutbox(join(dir, "notice-outbox"), hub as unknown as ThreadHub, line => { lines.push(line); }, { sleep: () => new Promise(resolve => setTimeout(resolve, 2)) });
  t.after(() => notices.close());
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  await index.add("gone");
  const chats = new Chats(index, hub, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), heldNotices: heldNoticeRecord(join(dir, "held-notices.json")), notices });
  await chats.notice(CHAT, "[check-in] 3 steps have no owner");
  await chats.notice("gone", "[check-in] nobody reads this");
  await notices.outbox.idle();
  assert.deepEqual(calls.filter(call => call.includes("3 steps")), Array(3).fill(`steer ${CHAT} [check-in] 3 steps have no owner`), "two failed tries, then the one that lands");
  assert.equal(calls.filter(call => call.includes("nobody reads")).length, 1, "a 404 is final");
  assert.ok(lines.some(line => /^outbox 01a1164b notice: n-\S+ try 1: Timed out/.test(line)), lines.join("\n"));
});

test("a notice to a chat on a box that reads offline waits with no try until the box is back", async t => {
  const dir = await mkdtemp(join(tmpdir(), "notice-offline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  let online = false;
  const hub = { async prompt(id: string, input: { message: string; sending?: () => Promise<void> }) { calls.push(`${id} ${input.message}`); await input.sending?.(); },
    copyOf: async () => "absent" as const };
  const notices = noticeOutbox(join(dir, "notice-outbox"), hub as unknown as ThreadHub, () => {},
    { sleep: () => new Promise(resolve => setTimeout(resolve, 2)), held: async () => !online });
  t.after(() => notices.close());
  await notices.send("01a15427-0000-7000-8000-000000000001", "[check-in] mac chat line");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, [], "no try while the Mac reads offline");
  online = true;
  await notices.outbox.idle();
  assert.deepEqual(calls, ["01a15427-0000-7000-8000-000000000001 [check-in] mac chat line"]);
});

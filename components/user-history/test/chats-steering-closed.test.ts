import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { clockTime } from "../src/checkin-settings.ts";
import { CHAT_BRIEF, loadRecord } from "../src/chat-brief.ts";
import { Chats, OLD_CHECK_IN } from "../src/chats.ts";
import { fileHasChatMarker } from "../src/chat-guard.ts";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { inSidebar } from "../src/client/organize.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { source, fakeThreads, row, ownerAsks, reply, TOKEN_FAILURE } from "./chats-helpers.ts";

// Notice times are the owner's local HH:MM; the expected strings are written for Seoul.
process.env.TZ = "Asia/Seoul";


test("an attach's steering call whose link the asleep detach closed is set at the next attach, with no failure line (10-21 21:50:24Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [], lines: string[] = [];
  const threads = Object.assign(fakeThreads(calls), {
    live: true,
    isLive(_id: string) { return this.live; },
    async setSteeringMode(_id: string, _mode: string) {
      this.live = false;
      throw new Error("Prime Agent daemon client closed before the operation completed. Socket: /tmp/prime-agent-1001/daemon.sock.");
    },
  });
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir), line => lines.push(line));
  await chats.ids();
  threads.fire().live("vp", []);
  await chats.settled();
  assert.ok(!lines.some(line => /closed before the operation completed/.test(line)), lines.join("\n"));
  assert.ok(lines.some(line => /let go asleep before its steering was set/.test(line)), lines.join("\n"));
});

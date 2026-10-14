import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { deletedJobRecord, type SubagentDelete } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * frontend bro 10-14: the cleanup logged "deleted finished job email app outside in" 5 times (02:18Z, 02:28Z, 03:11Z, 03:33Z, 03:36Z), each
 * after a service start, and the Harness VP's health fixes release 4 times. The daemon still lists the session sub-9b3a7eaa under the chat, and
 * a delete_rlm_subagent for it at 04:5xZ answered `{"success":true,"data":{"deleted":false}}`: the chat no longer holds it. The cleanup
 * remembered its deletes only in memory and read every success as a delete.
 */
const BOARD: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [] };
const NOW = Date.parse("2026-10-14T03:11:07Z");
const EMAIL: ChildAgent = { id: "sub-9b3a7eaa", label: "email app outside in", sessionName: "email app outside in", status: "done", repliedSinceTask: true,
  lastActivityAt: Date.parse("2026-10-14T00:16:22Z") };

/** The job's final report as the chat's transcript holds it. */
export const report = (name: string, at: number, body = "Done."): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n${body}`, display: true, timestamp: at }) as ThreadMessage;

async function serve(dir: string, answer: SubagentDelete, children: ChildAgent[]) {
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.deleteAnswer = answer;
  threads.transcripts.set("c1", children.map(child => report(child.label, child.lastActivityAt!)));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: BOARD }, () => NOW), deletedJobs: deletedJobRecord(join(dir, "deleted-jobs.json")) }, line => lines.push(line));
  await chats.adopt();
  threads.fire().live("c1", children);
  await chats.settled();
  await chats.tick();
  await chats.settled();
  chats.close();
  return { deletes: calls.filter(call => call.startsWith("delete")), lines: lines.filter(line => line.includes("finished job")) };
}

test("frontend bro 10-14: a finished job the daemon still lists after its delete is not deleted again after a service restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deleted-jobs-"));
  const first = await serve(dir, "not_held", [EMAIL]);
  assert.deepEqual(first.deletes, ["delete c1 sub-9b3a7eaa"]);
  assert.deepEqual(first.lines, ["chat c1: finished job email app outside in is no longer a subagent of the chat (the daemon still lists its session); recorded, not tried again"],
    "a delete the daemon answers with deleted false is not logged as a delete");
  for (let restart = 0; restart < 4; restart++) assert.deepEqual((await serve(dir, "not_held", [EMAIL])).deletes, [], `restart ${restart + 1} does not delete it again`);
});

test("frontend bro 10-14: a job the daemon deleted is logged once, and the record drops a job once the chat's listing no longer holds it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deleted-jobs-"));
  const first = await serve(dir, "deleted", [EMAIL]);
  assert.deepEqual(first.lines, ["chat c1: deleted finished job email app outside in (reported, quiet 175 min, no open step)"]);
  assert.deepEqual((await serve(dir, "deleted", [EMAIL])).deletes, []);
  const other: ChildAgent = { ...EMAIL, id: "sub-other", label: "other job", sessionName: "other job" };
  await serve(dir, "deleted", [other]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "deleted-jobs.json"), "utf8")).c1), ["sub-other"], "sub-9b3a7eaa left the listing, so it left the record");
});

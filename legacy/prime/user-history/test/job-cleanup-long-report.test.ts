// Guards the 10-28 18:18:10Z delete of (temp) mcp's job "updated release page": its 2,153-character report ended "I'm waiting for p40", the
// projection cut agent messages at NOTE_LIMIT (2,048), and the job cleanup read the cut copy as a report with no parked work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { finishedJobs, lastJobMessages } from "../src/chat-checkin.ts";
import { ImageStore, NOTE_LIMIT, Projector } from "../src/chat-projection.ts";
import type { ChatBoard, ChildAgent } from "../src/shared/types.ts";

const BODY = [
  "The rule-field recount lines now follow the publisher's latest correction. The page stays an unready draft.",
  ...Array.from({ length: 24 }, (_, index) => `${index + 1}. Section 4 line ${index + 1} names a field, a script or a dated count that the walk page keeps for the release owner.`),
  "Checks: prose-lint gives 0 errors and 0 warnings, and Aside shows 14 of 14 mermaid svgs with no syntax errors. I executed nothing. I'm waiting for p40, with no polling.",
].join("\n");
const TEXT = `[agent-message from child:updated release page]\n\n${BODY}`;

const project = (customType: string, content: string) => new Projector(new ImageStore()).message({
  role: "custom", customType, content, display: true, timestamp: Date.parse("2026-10-28T18:18:01.401Z"),
} as Parameters<Projector["message"]>[0])!;

const job: ChildAgent = { id: "sub-3b8c4209", sessionName: "updated release page", label: "updated release page", status: "done", repliedSinceTask: true,
  lastActivityAt: Date.parse("2026-10-28T18:18:05Z") };
const board = { plan: [{ id: "p41", text: "Prepare the replacement release page", status: "doing", job: "(temp) mcp", note: "The same draft waits on p40's final packet without polling.", children: [] }] } as unknown as ChatBoard;

test("a job's long report keeps its parked words through the projection, so the cleanup keeps the job", () => {
  assert.ok(TEXT.length > NOTE_LIMIT && TEXT.indexOf("I'm waiting for") > NOTE_LIMIT, "the parked words sit past the note limit, as on 10-28");
  const said = lastJobMessages([project("agent_message", TEXT)]);
  assert.equal(said.get("updated release page")?.parked, "I'm waiting for");
  assert.deepEqual(finishedJobs([job], board, said), []);
});

test("a finished job whose long report holds no parked words is still deleted", () => {
  const said = lastJobMessages([project("agent_message", TEXT.replace("I'm waiting for p40, with no polling.", "The page is done."))]);
  assert.deepEqual(finishedJobs([job], board, said).map(child => child.id), ["sub-3b8c4209"]);
});

test("a report the projection cut before its end keeps the job", () => {
  const said = lastJobMessages([{ role: "custom", customType: "agent_message", timestamp: 1, content: [{ type: "text", text: TEXT.slice(0, 300), truncated: true }] }]);
  assert.equal(said.get("updated release page")?.parked, "a report cut before its end");
  assert.deepEqual(finishedJobs([job], board, said), []);
});

test("other notes stay cut at the note limit", () => {
  const note = project("rlm_child_terminal_notice", "x".repeat(NOTE_LIMIT + 10));
  assert.ok(note.role === "custom" && Array.isArray(note.content) && note.content[0]?.type === "text" && note.content[0].text.length === NOTE_LIMIT && note.content[0].truncated === true);
});

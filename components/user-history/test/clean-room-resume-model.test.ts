// Guards clean-room w81 run3 on 10-23: the resume-model judge read the chat's own check-in job "check-in user history test count 17 24" as
// someone stepping in and voided the run. Criterion d now places each sender by recorded identity, as unrelated-ci-wait does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunState } from "../scripts/clean-room/session-read.ts";

const CHAT = "01a167ce-5baf-750c-958a-d0bab52e6630";
const CHECK_IN = "01a167d9-0000-7000-8000-000000000001";
const STRANGER = "01a167da-0000-7000-8000-000000000002";
const START = Date.parse("2026-10-23T08:09:23Z");

test("resume-model: the chat's own check-in job is the chat's own, and another chat's root steps in", async t => {
  const home = mkdtempSync(join(tmpdir(), "resume-model-judge-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.AGENT_CHAT_DATA_DIR = join(home, "browser-chat");
  const { resumeModel, TASK } = await import("../scripts/clean-room/resume-model.ts");
  const sessions = join(home, ".prime", "agent", "sessions");
  mkdirSync(sessions, { recursive: true });
  const heard = (from: string, fromId: string, minutes: number) => JSON.stringify({ type: "custom_message", customType: "agent_message",
    timestamp: new Date(START + minutes * 60_000).toISOString(), content: `[agent-message from sibling:${from}] Test file count is at 1 of 2 counts.`,
    details: { from: { sessionId: fromId, sessionName: from }, fromRelationship: "sibling" } });
  const judge = (extra: string[]) => {
    writeFileSync(join(sessions, `${CHAT}.jsonl`), [JSON.stringify({ type: "session", id: CHAT, timestamp: new Date(START).toISOString(), cwd: home }),
      JSON.stringify({ type: "message", timestamp: new Date(START).toISOString(), message: { role: "user", content: [{ type: "text", text: TASK }] } }),
      heard("check-in user history test count 17 24", CHECK_IN, 60), ...extra].join("\n") + "\n");
    writeFileSync(join(sessions, `${STRANGER}.jsonl`), JSON.stringify({ type: "session", id: STRANGER, timestamp: new Date(START).toISOString(), cwd: home, rlmDepth: 0 }) + "\n");
    const run = join(home, "run");
    mkdirSync(join(run, "agents"), { recursive: true });
    writeFileSync(join(run, "runs.jsonl"), JSON.stringify({ duty: "checkin", at: START + 15 * 60_000, job: { id: CHECK_IN, name: "check-in user history test count 17 24" } }) + "\n");
    writeFileSync(join(run, "agents", `${START}.json`), "[]");
    const state: RunState = { scenario: "resume-model", chat: { id: CHAT, name: "user history test count" }, fixtures: {}, sandbox: home, everyMs: 180 * 60_000,
      release: "release-test", board: "", seeds: [TASK], setupAt: START, windowStart: START };
    const { verdict, text } = resumeModel.evaluate(run, state) as { verdict: string; text: string };
    return { verdict, d: text.split("\n").find(line => line.startsWith("- d ")) ?? "" };
  };
  const own = judge([]);
  assert.match(own.d, /^- d met: only the owner-style message/, own.d);
  assert.equal(own.verdict, "open", "a, b and c are not reached yet, and the check-in does not void the run");
  const stepped = judge([heard("ops guy", STRANGER, 70)]);
  assert.match(stepped.d, /^- d not met: .*ops guy|^- d not met: .*root session outside the trial/, stepped.d);
  assert.equal(stepped.verdict, "void");
});

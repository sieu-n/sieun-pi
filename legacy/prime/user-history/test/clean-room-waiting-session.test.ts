// Guards the w81-waiting-session judge (chat-2572 c84, 10-26): a job that waits on its own board.wake passes only when the same session, on
// openai-codex/gpt-6.1-sol at medium before and after, was idle-unloaded in between and woke on the wake service's message with nobody stepping in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunState } from "../scripts/clean-room/session-read.ts";

const CHAT = "01a17900-0000-7000-8000-000000000001";
const JOB = "01a17902-0000-7000-8000-000000000002";
const START = Date.parse("2026-10-26T13:30:00Z");
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

test("waiting-session: pass on one session through unload and wake; fail on a steer before the wake; void on no model turn", async t => {
  const home = mkdtempSync(join(tmpdir(), "waiting-session-judge-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.AGENT_CHAT_DATA_DIR = join(home, "browser-chat");
  const { waitingSession, TASK } = await import("../scripts/clean-room/waiting-session.ts");
  const agent = join(home, ".prime", "agent");
  const sub = join(agent, "session-artifacts", CHAT, "sub-1");
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(agent, "sessions"), { recursive: true });
  const jobFile = join(sub, `${JOB}.jsonl`);
  writeFileSync(join(sub, "rlm-subagent.json"), JSON.stringify({ childId: "sub-1", sessionName: "test file count", sessionFile: jobFile,
    model: { provider: "openai-codex", modelId: "gpt-6.1-sol" } }));
  writeFileSync(join(agent, "sessions", `${CHAT}.jsonl`), [JSON.stringify({ type: "session", id: CHAT, timestamp: at(0), cwd: home }),
    JSON.stringify({ type: "message", timestamp: at(0), message: { role: "user", content: [{ type: "text", text: TASK }] } })].join("\n") + "\n");
  const reply = (minutes: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: at(minutes),
    message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "stop", content: [{ type: "text", text: "ok" }], ...extra } });
  const run = join(home, "run");
  mkdirSync(join(run, "agents"), { recursive: true });
  mkdirSync(join(run, "wakes"), { recursive: true });
  writeFileSync(join(run, "agents", `${START}.json`), JSON.stringify([{ sessionId: JOB, link: "subagent" }]));
  writeFileSync(join(run, "wakes", `${JOB}-time-1793023200.json`), "{}");
  writeFileSync(join(run, "service.log"), `${at(36).replace(/\.\d+Z$/, ".000Z")} wakes: woke ${JOB} for its time, waited 30 min, queued 0 s after the tick began\n`);
  const state: RunState = { scenario: "waiting-session", chat: { id: CHAT, name: "test file counts" }, fixtures: {}, sandbox: home, everyMs: 180 * 60_000,
    release: "release-test", board: "", seeds: [TASK], setupAt: START, windowStart: START };
  const judge = (lines: string[]) => {
    writeFileSync(jobFile, lines.join("\n") + "\n");
    return waitingSession.evaluate(run, state) as { verdict: string; text: string };
  };
  const head = [JSON.stringify({ type: "session", id: JOB, timestamp: at(1) }),
    JSON.stringify({ type: "model_change", timestamp: at(1), provider: "openai-codex", modelId: "gpt-6.1-sol" }),
    JSON.stringify({ type: "thinking_level_change", timestamp: at(1), thinkingLevel: "medium" }),
    JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(1), content: "[task from parent] count" }),
    reply(2), reply(5, { content: [{ type: "toolCall", name: "ipython", arguments: { code: "board.wake(at=time.time()+1800)" } }] })];
  const unload = [JSON.stringify({ type: "session_state", timestamp: at(8), state: { status: "archived", reason: "idle_unload" } }),
    JSON.stringify({ type: "session_state", timestamp: at(8), state: { status: "active" } })];
  const wake = JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(36), content: `[wake] It is ${at(36)}, the time you set with board.wake (${at(35)}).` });
  const pass = judge([...head, ...unload, wake, reply(37)]);
  assert.equal(pass.verdict, "pass", pass.text);
  const steered = judge([...head, ...unload, JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(20), content: "[agent-message from parent] count now" }), wake, reply(37)]);
  assert.equal(steered.verdict, "fail", steered.text);
  assert.match(steered.text, /- d not met: .*before it, after the last unload \(.*\), the job got/);
  const noUnload = judge([...head, wake, reply(37)]);
  assert.equal(noUnload.verdict, "fail", noUnload.text);
  assert.match(noUnload.text, /- c not met/);
  const otherModel = judge([...head, ...unload, wake, reply(37, { provider: "anthropic", model: "claude-opus-5-5" })]);
  assert.match(otherModel.text, /- f not met/);
  const failed = judge([...head, ...unload, wake, reply(37, { stopReason: "error" })]);
  assert.equal(failed.verdict, "open", "a pool wait right after the wake leaves e and f open while the window runs");
  const ended = waitingSession.evaluate(run, { ...state, until: START }) as { verdict: string; text: string };
  assert.equal(ended.verdict, "void", ended.text);
  // run2 on 10-28: the pool resumed the job's own parked turn ("continue", with Prime's harness digest) after the first unload, the job
  // finished that turn and was unloaded again before the wake. Neither message counts, and the last unload before the wake is the one d reads.
  const park = JSON.stringify({ type: "custom", customType: "provider_quota_park", timestamp: at(9), data: { resumeAt: at(29) } });
  const digest = JSON.stringify({ type: "custom_message", customType: "harness-digest", timestamp: at(29), content: "[harness-digest] The persistent memories" });
  const resume = JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(29), content: "[agent-message from parent:test file recount 2]  continue" });
  const reunload = JSON.stringify({ type: "session_state", timestamp: at(33), state: { status: "archived", reason: "idle_unload" } });
  const resumed = judge([...head, ...unload, reply(9, { stopReason: "error" }), park, digest, resume, reply(30), reunload, wake, reply(37)]);
  assert.equal(resumed.verdict, "pass", resumed.text);
  assert.match(resumed.text, /not counted: .*harness digest, .*pool resume/);
  const asked = judge([...head, ...unload, JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(29), content: "[agent-message from parent:x]  continue" }),
    reply(30), reunload, wake, reply(37)]);
  assert.equal(asked.verdict, "pass", "a message before the last unload does not count for d");
  const late = judge([...head, ...unload, reunload, JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(34), content: "[agent-message from parent:x]  continue" }), wake, reply(37)]);
  assert.equal(late.verdict, "fail", "a 'continue' with no park before it, after the last unload, still counts");
  const early = judge([...head, ...unload, reunload, JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: at(34), content: "[agent-message from parent:x] count now" }), wake]);
  assert.equal(early.verdict, "open", "d is not met, but the verdict waits for e and f");
  const waiting = judge([...head, ...unload]);
  assert.equal(waiting.verdict, "open", waiting.text);
});

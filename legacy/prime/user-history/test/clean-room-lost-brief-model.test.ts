// Guards the w81-brief-keeper B judge (10-28): the keeper's restart of a child that never became a session passes only when the chat spawned it
// with no model or thinking, its spawn record holds the chat's model and thinking, and the restarted root runs on them; the kill is the one
// declared fault.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunState } from "../scripts/clean-room/session-read.ts";

const CHAT = "01a18100-0000-7000-8000-000000000001";
const ROOT = "01a18102-0000-7000-8000-000000000002";
const START = Date.parse("2026-10-28T02:20:00Z");
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

test("lost-brief-model: pass on a restart on the inherited model; fail on the default; open when the keeper sent instead", async t => {
  const home = mkdtempSync(join(tmpdir(), "lost-brief-model-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.AGENT_CHAT_DATA_DIR = join(home, "browser-chat");
  const { lostBriefModel, TASK } = await import("../scripts/clean-room/lost-brief-model.ts");
  const sessions = join(home, ".prime", "agent", "sessions");
  mkdirSync(sessions, { recursive: true });
  const call = (code: string) => JSON.stringify({ type: "message", timestamp: at(20), message: { role: "assistant", content: [{ type: "toolCall", name: "ipython", arguments: { code } }] } });
  const chatFile = (code: string) => writeFileSync(join(sessions, `${CHAT}.jsonl`), [JSON.stringify({ type: "session", id: CHAT, timestamp: at(0), cwd: home }),
    JSON.stringify({ type: "message", timestamp: at(0), message: { role: "user", content: [{ type: "text", text: TASK }] } }), call(code)].join("\n") + "\n");
  const run = join(home, "run");
  mkdirSync(join(run, "agents"), { recursive: true });
  writeFileSync(join(run, "agents", `${START}.json`), "[]");
  const record = { kind: "child", id: "sub-aa11bb22", name: "ts count", prompt: "count", at: START + 21_000, root: CHAT, sessionDir: join(home, "x"), model: "openai-codex/gpt-6.1-sol", thinking: "high" };
  writeFileSync(join(run, "kill.json"), JSON.stringify({ at: START + 21_050, pid: 1, workerId: "w1", record, fileStarted: false, journalRan: false, journal: "" }));
  const state: RunState = { scenario: "lost-brief-model", chat: { id: CHAT, name: "ts file count" }, fixtures: {}, sandbox: home, everyMs: 180 * 60_000,
    release: "release-test", board: "", seeds: [TASK], setupAt: START, windowStart: START };
  const rootFile = (model: string, level: string) => writeFileSync(join(sessions, `${ROOT}.jsonl`), [JSON.stringify({ type: "session", id: ROOT, timestamp: at(330) }),
    JSON.stringify({ type: "model_change", timestamp: at(330), provider: model.split("/")[0], modelId: model.split("/")[1] }),
    JSON.stringify({ type: "thinking_level_change", timestamp: at(330), thinkingLevel: level }),
    JSON.stringify({ type: "message", timestamp: at(340), message: { role: "assistant", provider: model.split("/")[0], model: model.split("/")[1], stopReason: "stop", content: [] } })].join("\n") + "\n");
  const restartLine = `${at(330)} briefs: child ts count (sub-aa11bb22) never became a session 5 min after its spawn; started root job ${ROOT} of its chat with its brief\n`;
  const judge = () => lostBriefModel.evaluate(run, state) as { verdict: string; text: string };

  chatFile("handle = await rlm.spawn(brief, name='ts count')");
  writeFileSync(join(run, "service.log"), restartLine);
  rootFile("openai-codex/gpt-6.1-sol", "high");
  const pass = judge();
  assert.equal(pass.verdict, "pass", pass.text);
  assert.match(pass.text, /injected fault/);
  rootFile("anthropic/claude-opus-5-5", "high");
  assert.equal(judge().verdict, "fail", "a root on the daemon's default model fails e");
  rootFile("openai-codex/gpt-6.1-sol", "high");
  chatFile("handle = await rlm.spawn(brief, name='ts count', model='openai-codex/gpt-6.1-sol')");
  assert.match(judge().text, /- b not met/);
  chatFile("handle = await rlm.spawn(brief, name='ts count')");
  writeFileSync(join(run, "service.log"), `${at(330)} briefs: child ts count (sub-aa11bb22) has its first prompt now; record dropped\n`);
  const sent = judge();
  assert.equal(sent.verdict, "open", sent.text);
  assert.match(sent.text, /- d not reached yet: path not reached/);
});

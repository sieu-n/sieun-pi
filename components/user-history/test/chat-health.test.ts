import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => NOW - ms;
const wordsOf = (count: number, bullets = false) => Array.from({ length: count }, (_, index) => (bullets && index % 10 === 0 ? "\n- " : "") + "w" + index).join(" ");

type Line = Record<string, unknown>;
const entry = (message: Record<string, unknown>): Line => ({ type: "message", timestamp: new Date(message.timestamp as number).toISOString(), message });
const user = (at: number, text: string): Line => entry({ role: "user", content: [{ type: "text", text }], timestamp: at });
const reply = (at: number, text: string, stopReason = "stop", extra: Record<string, unknown> = {}): Line =>
  entry({ role: "assistant", content: text ? [{ type: "text", text }] : [], provider: "p", model: "m", stopReason, timestamp: at, ...extra });
const toolCall = (at: number, name: string, text = ""): Line =>
  entry({ role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: "c" + at, name, arguments: { text: "hi" } }], provider: "p", model: "m", stopReason: "toolUse", timestamp: at });
const toolResult = (at: number): Line => entry({ role: "toolResult", toolCallId: "c" + (at - 1), toolName: "t", content: [], isError: false, timestamp: at });
const custom = (at: number, customType: string, content: string): Line => ({ type: "custom_message", customType, content, display: true, timestamp: new Date(at).toISOString() });

const CHECK_IN = [
  "[check-in] What changed:",
  "- p5 \"a\" is todo with no board change and no owner activity for 8 h",
  "- p6 \"b\" is todo with no board change and no owner activity for 90 min",
  "- p7 \"c\" is doing with no board change and no owner activity for 130 min",
  "- p8 \"d\" is doing with no board change and no owner activity for 3 d",
].join("\n");

const chatA: Line[] = [
  { type: "session", id: "a", timestamp: new Date(ago(31 * HOUR)).toISOString() },
  user(ago(30 * HOUR), "why did you stop again"),
  reply(ago(30 * HOUR) + MIN, wordsOf(70)),
  user(ago(10 * HOUR), "<skill name=\"x\">\ndon't, never, wrong\n</skill>\n\nplease check the build"),
  reply(ago(10 * HOUR) + MIN, wordsOf(70)),
  user(ago(9 * HOUR), "you didn't commit it, i told you"),
  toolCall(ago(9 * HOUR) + MIN, "bash", "Looking."),
  toolResult(ago(9 * HOUR) + MIN + 1),
  reply(ago(9 * HOUR) + 2 * MIN, wordsOf(10)),
  user(ago(8 * HOUR), "[board] Owner chose \"Don't ship\" for \"Never mind the wrong thing\""),
  reply(ago(8 * HOUR) + MIN, wordsOf(5)),
  user(ago(7 * HOUR), "[board] Owner checked \"x\" and answered: that is wrong"),
  reply(ago(7 * HOUR) + MIN, wordsOf(61, true)),
  user(ago(6.5 * HOUR), "ok thanks"),
  reply(ago(6.5 * HOUR) + 10_000, "", "error", { errorMessage: "Connection error." }),
  reply(ago(6.5 * HOUR) + 30_000, wordsOf(60, true)),
  user(ago(6 * HOUR), "hello"),
  reply(ago(6 * HOUR) + MIN, "", "aborted"),
  custom(ago(5 * HOUR), "refinement_outcome", "Refinement complete"),
  user(ago(4 * HOUR), CHECK_IN),
  reply(ago(4 * HOUR) + MIN, "Checked the board."),
  user(ago(3 * HOUR), CHECK_IN),
  toolCall(ago(3 * HOUR) + MIN, "chat_board"),
  toolResult(ago(3 * HOUR) + MIN + 1),
  reply(ago(3 * HOUR) + 2 * MIN, ""),
  user(ago(2 * HOUR), "[job] build-x finished; don't wait"),
  toolCall(ago(2 * HOUR) + MIN, "tell_owner"),
  toolResult(ago(2 * HOUR) + MIN + 1),
  reply(ago(2 * HOUR) + 2 * MIN, ""),
  user(ago(1.5 * HOUR), "[job] build-x finished; don't wait"),
  reply(ago(1.5 * HOUR) + MIN, "", "error", { errorMessage: "Failed to resolve API key" }),
];

const chatB: Line[] = [
  user(ago(26 * HOUR), "[check-in] What changed:\n- nothing new"),
  reply(ago(26 * HOUR) + MIN, wordsOf(3)),
  custom(ago(5 * HOUR), "agent_message", "[agent-message from worker]\n\nDone."),
  reply(ago(5 * HOUR) + MIN, "Noted, filing it."),
  user(ago(4 * HOUR), "stop doing that"),
  reply(ago(4 * HOUR) + MIN, "OK."),
  user(ago(3 * HOUR), "do the thing"),
  reply(ago(3 * HOUR) + MIN, "", "aborted"),
  user(ago(3 * HOUR) + 10 * MIN, "hi"),
  reply(ago(3 * HOUR) + 11 * MIN, "Hello there."),
  custom(ago(2 * HOUR), "heartbeat_prompt", "[heartbeat]\n\nbeat"),
  reply(ago(2 * HOUR) + MIN, "beat"),
  user(ago(1 * HOUR), CHECK_IN),
  reply(ago(1 * HOUR) + MIN, "x"),
  user(ago(0.5 * HOUR), "[check-in] What changed:\n- nothing new"),
  reply(ago(0.5 * HOUR) + MIN, ""),
  user(NOW + HOUR, "you were wrong"),
];

const script = join(import.meta.dirname, "..", "scripts", "duties", "chat-health.ts");
const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--import", "tsx", script], { cwd: join(import.meta.dirname, ".."), encoding: "utf8",
  env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ...env } });

test("chat health: each metric over two fixture chats in the last 24 h; a missing transcript is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-a", "chat-b", "chat-missing"] }));
    await writeFile(join(dir, "chat-a.jsonl"), chatA.map(line => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(join(dir, "chat-b.jsonl"), chatB.map(line => JSON.stringify(line)).join("\n") + "\nnot json\n");
    const output = join(dir, "out", "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.deepEqual(health.metrics, { corrections: 3, stalls_2h: 9, dead_hours: 3.5, unretried_errors: 2, dup_system_lines: 2, long_replies: 28.6, wake_text: 3 });
    const flagged = health.flagged ?? [];
    assert.deepEqual(flagged.slice(0, 3).map(slice => [slice.chat, slice.excerpt]), [["chat-b", "stop doing that"], ["chat-a", "that is wrong"], ["chat-a", "you didn't commit it, i told you"]]);
    const kinds = (kind: string) => flagged.filter(slice => slice.kind === kind);
    assert.deepEqual(kinds("unretried_errors").map(slice => slice.excerpt), ["1.5 h with no new message after: Failed to resolve API key", "2.0 h with no new message after: stopReason aborted"]);
    assert.deepEqual(kinds("long_replies").map(slice => slice.excerpt.split(":")[0]), ["61 words", "70 words"]);
    assert.equal(kinds("stalls_2h").length, 9);
    assert.ok(kinds("stalls_2h").every(slice => !slice.excerpt.includes("90 min")));
    assert.deepEqual(kinds("dup_system_lines").map(slice => slice.excerpt), ["[job] build-x finished; don't wait", CHECK_IN.slice(0, 300)]);
    assert.deepEqual(kinds("wake_text").map(slice => slice.excerpt), ["x", "Checked the board.", "Noted, filing it."]);
    assert.ok(flagged.length <= 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: no owner turns gives long_replies 0; no OUTPUT_FILE exits nonzero with a message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [] }));
    const output = join(dir, "health.json");
    const empty = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { metrics: { corrections: 0, stalls_2h: 0, dead_hours: 0, unretried_errors: 0, dup_system_lines: 0, long_replies: 0, wake_text: 0 }, flagged: [] });
    const missing = run({ CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /OUTPUT_FILE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

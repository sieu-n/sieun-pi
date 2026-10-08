import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import { fixTargets, recheckSlices } from "../scripts/duties/chat-health-recheck.ts";

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

const API_KEY_ERROR = "Failed to resolve API key for provider \"anthropic\" from shell command: /Users/x/.config/pi-pool/bin/pi-pool-token";

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
  reply(ago(1.5 * HOUR) + MIN, "", "error", { errorMessage: API_KEY_ERROR }),
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
  env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CHAT_HEALTH_GIT_DIR: "/nonexistent", ...env } });

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
    assert.deepEqual(health.metrics, { corrections: 3, stalls_2h: 6, dead_hours: 3.5, unretried_errors: 2, long_replies: 28.6, off_brief: 2, sieun_pi_breaks: 1, recurred: 0 });
    const flagged = health.flagged ?? [];
    assert.deepEqual(flagged.slice(0, 3).map(slice => [slice.chat, slice.excerpt]), [["chat-b", "stop doing that"], ["chat-a", "that is wrong"], ["chat-a", "you didn't commit it, i told you"]]);
    const kinds = (kind: string) => flagged.filter(slice => slice.kind === kind);
    assert.deepEqual(kinds("unretried_errors").map(slice => slice.excerpt), [`1.5 h with no new message after: ${API_KEY_ERROR}`, "2.0 h with no new message after: stopReason aborted"]);
    assert.deepEqual(kinds("long_replies").map(slice => slice.excerpt.split(":")[0]), ["61 words", "70 words"]);
    assert.equal(kinds("stalls_2h").length, 6);
    assert.ok(kinds("stalls_2h").some(slice => slice.chat === "chat-a" && slice.excerpt.includes("p8") && slice.at === ago(3 * HOUR)), "a step counts once, at its latest check-in row");
    assert.ok(kinds("stalls_2h").every(slice => !slice.excerpt.includes("90 min")));
    assert.deepEqual(kinds("sieun_pi_breaks").map(slice => slice.excerpt), [API_KEY_ERROR]);
    assert.deepEqual(kinds("off_brief").map(slice => slice.excerpt), ["repeated line: [job] build-x finished; don't wait", `repeated line: ${CHECK_IN}`.slice(0, 300)],
      "text on a wake is the chat's notes (the brief allows it since W27); only repeated server lines are off brief");
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
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { metrics: { corrections: 0, stalls_2h: 0, dead_hours: 0, unretried_errors: 0, long_replies: 0, off_brief: 0, sieun_pi_breaks: 0, recurred: 0 }, flagged: [] });
    const missing = run({ CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /OUTPUT_FILE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: a problem a run flagged is watched; the next run counts it once when it happens again, and not when nothing new happened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-a"] }));
    const transcript = join(dir, "chat-a.jsonl");
    await writeFile(transcript, chatA.map(line => JSON.stringify(line)).join("\n") + "\n");
    const state = join(dir, "state.json");
    const output = join(dir, "health.json");
    const runAt = async (now: number) => {
      const result = run({ OUTPUT_FILE: output, STATE_FILE: state, CHAT_HEALTH_NOW: String(now), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    };
    assert.equal((await runAt(NOW)).metrics.recurred, 0);
    assert.equal((await runAt(NOW)).metrics.recurred, 0);
    const again = [user(NOW + 10 * MIN, "retry"), reply(NOW + 11 * MIN, "", "error", { errorMessage: API_KEY_ERROR }),
      user(NOW + 20 * MIN, "[job] build-x finished; don't wait")];
    await writeFile(transcript, [...chatA, ...again].map(line => JSON.stringify(line)).join("\n") + "\n");
    const next = await runAt(NOW + HOUR);
    assert.equal(next.metrics.recurred, 2);
    const recurred = (next.flagged ?? []).filter(slice => slice.kind === "recurred").map(slice => slice.excerpt);
    assert.equal(recurred.length, 2);
    assert.ok(recurred.some(excerpt => excerpt.startsWith("off_brief, first flagged 2026-10-08: repeated line: [job] build-x")), recurred.join("\n"));
    assert.ok(recurred.some(excerpt => excerpt.startsWith("sieun_pi_breaks, first flagged 2026-10-08: ") || excerpt.startsWith("unretried_errors, first flagged 2026-10-08: ")), recurred.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: owner directions and status questions are not corrections, a quoted question is not the owner's, a provider error the pool retried is not a sieun-pi break, and a stalled step counts once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    const corrections = [
      "what the fuck is this diagram, and still don't understand what Github pro changes??",
      "so explain more, i dont get it",
      "also why is nothing being done are you sure the checks are running properly??",
      "can you make it so pi-agent never says shit like s20?",
      "also i said merge the Jobs thing into the left sidebar and remove the pill",
      "also even if i say i Korean always message in English never in Korean",
    ];
    const notCorrections = [
      "good you asked me. NEVER litellm. terrible terrible idea.",
      "is writer still going on?",
      "im back stop the ampethamine thing",
      "Can you use computer use to reset amphetimine and set it again?",
      "also why is everything complaining about ci in short?",
      "the frontend shape should have scenarios",
      "Authentication is repaired. Please answer my last unanswered question: \u201cso explain more, i dont get it\u201d.",
    ];
    const retried = "Provider rate limit exceeded (rate_limit_error, 429): Please try again later. pi-pool: a@x is limited until 2026-10-08T13:20:00.000Z; the retry uses b@x.";
    const lines: Line[] = [...corrections, ...notCorrections].flatMap((text, index) => [user(ago(20 * HOUR) + index * MIN, text), reply(ago(20 * HOUR) + index * MIN + 1_000, "ok")]);
    lines.push(user(ago(4 * HOUR), "[check-in] What changed:\n- p9 \"x\" is doing with no board change and no owner activity for 3 h"), reply(ago(4 * HOUR) + MIN, ""),
      user(ago(3 * HOUR), "[check-in] What changed:\n- p9 \"x\" is blocked with no board change and no owner activity for 4 h"), reply(ago(3 * HOUR) + MIN, ""));
    lines.push(user(ago(2 * HOUR), "go"), reply(ago(2 * HOUR) + 1_000, "", "error", { errorMessage: retried }), reply(ago(2 * HOUR) + 20_000, "done"));
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-c"] }));
    await writeFile(join(dir, "chat-c.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "corrections").map(slice => slice.excerpt).sort(), [...corrections].sort());
    assert.equal(health.metrics.sieun_pi_breaks, 0);
    assert.equal(health.metrics.unretried_errors, 0);
    assert.equal(health.metrics.stalls_2h, 1, "a step that moved from doing to blocked is one stalled step");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health recheck: each fix names the metrics its subject targets, with today's value; one that names none is for a person to judge", () => {
  assert.deepEqual(fixTargets("fix(user-history): long owner replies get a reply rule; text on wake-ups is notes; a stalled step sets waitUntil"), ["long_replies", "off_brief", "stalls_2h"]);
  assert.deepEqual(fixTargets("fix(user-history): plain derived thread names"), []);
  const metrics = { corrections: 4, stalls_2h: 3, dead_hours: 0, unretried_errors: 0, long_replies: 82.8, off_brief: 21, sieun_pi_breaks: 0, recurred: 0 };
  assert.deepEqual(recheckSlices([
    { sha: "abc1234", at: 5, subject: "fix(user-history): owner replies stay under 60 words" },
    { sha: "def5678", at: 6, subject: "fix(user-history): plain derived thread names" },
  ], metrics), [
    { at: 5, kind: "recheck", excerpt: "fixed yesterday, recheck today: long_replies 82.8 today; abc1234 owner replies stay under 60 words" },
    { at: 6, kind: "recheck", excerpt: "fixed yesterday, recheck today: no metric named; judge it by hand; def5678 plain derived thread names" },
  ]);
});

test("chat health recheck: the run lists yesterday's fix(user-history) commits first in flagged, not today's or older ones, nor other subjects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    const git = (args: string[], at?: number) => {
      const date = at === undefined ? {} : { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() };
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", ...date } });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-q"]);
    const commit = async (subject: string, at: number) => { await writeFile(join(dir, "file.txt"), subject); git(["add", "file.txt"]); git(["commit", "-q", "-m", subject], at); };
    await commit("fix(user-history): too old, a stalled step", ago(50 * HOUR));
    await commit("fix(user-history): text on wakes is notes", ago(30 * HOUR));
    await commit("feat(user-history): a new card", ago(28 * HOUR));
    await commit("fix(user-history): today's fix to long replies", ago(2 * HOUR));
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [] }));
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir, CHAT_HEALTH_GIT_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.deepEqual((health.flagged ?? []).map(slice => [slice.kind, slice.at, slice.excerpt.replace(/; \w{7,} /, "; <sha> ")]),
      [["recheck", Math.floor(ago(30 * HOUR) / 1000) * 1000, "fixed yesterday, recheck today: off_brief 0 today; <sha> text on wakes is notes"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

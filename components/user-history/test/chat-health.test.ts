import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NO_MISSES } from "../src/chat-checkin.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import { fixTargets, recheckSlices } from "../scripts/duties/chat-health-recheck.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { CLEAN_REPLIES, SLOP_REPLIES } from "./reply-lint-replies.ts";

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

/** VP of SEO (01a11a24), 10-12 13:56Z: the tell_owner reply the owner read, and the turn's own text the page folded into updates. */
const TOLD_QUIET_PLAN = "Okay, no emails or listings. [quiet authority plan](job:quiet authority plan) looks at getting quoted in ChatGPT answers, which already brings 11 of our 29 signups. It also looks at embeddable charts and helpful Reddit answers through your Google login. I'll show you every Reddit reply before it goes out.";
const NOTES_QUIET_PLAN = "I dropped the emails and listings and started [quiet authority plan](job:quiet authority plan) to find quieter ways to grow. Nothing goes out without you.\n\nIt is looking into five channels at once:\n- **AI answers:** getting our studies quoted by ChatGPT, Perplexity and Google's AI answers. ChatGPT already sent 11 of our 29 signups in the last 28 days, more than any other source.\n- **Embeds:** charts and calculators that other sites can embed, with a credit link back to us.\n- **Open data:** free downloads of our study numbers, credited back to us.\n- **Our own sites:** cross-links between the blog, the tools and the API docs.\n- **Reddit:** it can sign in with your Google account in Aside and draft a few helpful answers that use our numbers.\n\nFor Reddit, it may only read and draft. No posts, comments, messages, votes or follows. Every draft comes to me with the thread link and the exact text, and I show it to you before anything is sent.\n\nIt will come back with the top three moves, the evidence for each, and which ones can ship on the blog now. Moves that need main-app changes wait until you say the 5180 demo is good enough.";

const API_KEY_ERROR = "Failed to resolve API key for provider \"anthropic\" from shell command: /Users/x/.config/pi-pool/bin/pi-pool-token";

const openSteps = (rows: readonly string[]) => `\n\nOpen steps, oldest change first:\n${rows.map(row => `- ${row}`).join("\n")}`;
const CHECK_IN = "[check-in] What changed:\n- p5 \"a\" is due since 08:00: act on it or set a new waitUntil" + openSteps([
  "p5 (due) \"a\" doing, owner you, waits until 2026-10-08 08:00, last change 8 h ago",
  "p6 (waiting) \"b\" blocked, owner you, waits for \"land 30\", last change 90 min ago",
  "p7 (stale-chase) \"c\" blocked, owner you, waits for \"land 31\", last change 130 min ago",
  "p8 (stale-chase) \"d\" blocked, owner you, waits for \"land 32\", last change 3 d ago",
]);

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
  user(ago(26 * HOUR), "[check-in] What changed:\n- nothing new" + openSteps(["p5 (orphan) \"a\" todo, no owner, last change 7 h ago",
    "p7 (waiting) \"c\" blocked, owner you, waits for \"land 31\", last change 30 min ago", "p8 (stale-chase) \"d\" blocked, owner you, waits for \"land 32\", last change 2 d ago"])),
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
    assert.deepEqual(health.metrics, { corrections: 3, repeat_corrections: 0, unlinked_job_mentions: 0, placeholder_todos: 0, dead_hours: 3.5, unretried_errors: 2, long_replies: 28.6, slop_replies: 2, off_brief: 2, sieun_pi_breaks: 1, recurred: 0, unfixed_flags: 0, owner_board_asks: 0, no_progress_hours: 0, checkin_ops_dropped: 0, end_state_pct: 100, steps_moving_pct: 100, stuck_step_hours: 0, open_step_hours: 0, stuck_after_checkin: 0, owner_paused_stuck: 0, checkin_not_running: 0, ...NO_MISSES });
    const flagged = health.flagged ?? [];
    assert.deepEqual(flagged.slice(0, 4).map(slice => [slice.chat, slice.excerpt]), [["chat-a", API_KEY_ERROR], ["chat-b", "stop doing that"], ["chat-a", "that is wrong"], ["chat-a", "you didn't commit it, i told you"]],
      "a judged metric's lines (sieun_pi_breaks) come before the context ones");
    const kinds = (kind: string) => flagged.filter(slice => slice.kind === kind);
    assert.deepEqual(kinds("unretried_errors").map(slice => slice.excerpt), [`1.5 h with no new message after: ${API_KEY_ERROR}`, "2.0 h with no new message after: stopReason aborted"]);
    assert.deepEqual(kinds("long_replies").map(slice => slice.excerpt.split(":")[0]), ["61 words", "70 words"]);
    assert.deepEqual(kinds("slop_replies").map(slice => [slice.chat, slice.excerpt.split(":")[0]]), [["chat-a", "6 bullets"], ["chat-a", "7 bullets"]], "length alone is long_replies");
    assert.deepEqual(kinds("sieun_pi_breaks").map(slice => slice.excerpt), [API_KEY_ERROR]);
    assert.deepEqual(kinds("off_brief").map(slice => slice.excerpt), ["repeated line: [job] build-x finished; don't wait", `repeated line: ${CHECK_IN}`.slice(0, 300)],
      "text on a wake is the chat's notes (the brief allows it since W27); only repeated server lines are off brief");
    assert.ok(flagged.length <= 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: a reply is long when the page folds it, so a diagram or a link list the owner sees whole is not long", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  const diagram = "```mermaid\nflowchart LR\n" + Array.from({ length: 20 }, (_, index) => `  A${index}[Agent test push] --> B${index}[Prod keys]`).join("\n") + "\n```";
  const links = Array.from({ length: 6 }, (_, index) => `- [variant ${index}](http://localhost:5180/configure?scenario=kbeauty-brand&v.watchlist=v${index})`).join("\n");
  const chat: Line[] = [
    user(ago(3 * HOUR), "show me why"), reply(ago(3 * HOUR) + MIN, `${wordsOf(40)}\n\n${diagram}`),
    user(ago(2 * HOUR), "send the links"), reply(ago(2 * HOUR) + MIN, `Open each one:\n\n${links}`),
    user(ago(1 * HOUR), "and the rest?"), reply(ago(1 * HOUR) + MIN, `${wordsOf(55)} [the page](wiki:a/b/c.html) ${wordsOf(5)}`),
  ];
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat"] }));
    await writeFile(join(dir, "chat.jsonl"), chat.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.long_replies, 33.3);
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "long_replies").map(slice => slice.excerpt.split(":")[0]), ["64 words"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: slop_replies counts owner replies the reply lint flags for more than length, quoting the findings, with the owner's words spared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  const stages = SLOP_REPLIES["two stages"]!, builtIn = SLOP_REPLIES["built-in duty"]!, pro = SLOP_REPLIES["pro bullets"]!, clean = CLEAN_REPLIES["clean pro check"]!;
  const chat: Line[] = [
    user(ago(5 * HOUR), stages.owner), reply(ago(5 * HOUR) + MIN, stages.reply),
    user(ago(4 * HOUR), builtIn.owner), reply(ago(4 * HOUR) + MIN, builtIn.reply),
    user(ago(3 * HOUR), pro.owner), reply(ago(3 * HOUR) + MIN, pro.reply),
    user(ago(2 * HOUR), clean.owner), reply(ago(2 * HOUR) + MIN, clean.reply),
    user(ago(1 * HOUR), "[check-in] What changed"), reply(ago(1 * HOUR) + MIN, "Update: notes on a wake-up \u2014 the owner reads them folded."),
  ];
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["dev-vp"] }));
    await writeFile(join(dir, "dev-vp.jsonl"), chat.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.slop_replies, 3, "the two stages, the built-in duty and the 4 bullets; not the clean one, not wake-up notes");
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "slop_replies").map(slice => [slice.chat, slice.excerpt.slice(0, slice.excerpt.indexOf(": "))]), [
      ["dev-vp", "4 bullets"],
      ["dev-vp", 'internal terms "기본으로 들어가", "보드 관리"'],
      ["dev-vp", 'label opener "**코드 체크.**", "**프롬프트.**"; abstract words "단계", "계산"'],
    ], "newest first; duty is spared since the owner said it");
    assert.deepEqual(fixTargets("fix(user-history): a reply lint runs before the owner sees slop"), ["slop_replies"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: an owner turn answered with tell_owner counts the told text, since the page folds the turn's own text into updates (VP of SEO, 10-12 22:56 KST)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  const call = (at: number, id: string, text: string): Line =>
    entry({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], provider: "p", model: "m", stopReason: "toolUse", timestamp: at });
  const result = (at: number, id: string, isError: boolean): Line =>
    entry({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: isError ? "Refused" : "told the owner" }], isError, timestamp: at });
  const chat: Line[] = [
    user(ago(3 * HOUR), "you can use my google account via reddit but tell me ANYTIME before jessage"),
    call(ago(3 * HOUR) + MIN, "t1", TOLD_QUIET_PLAN), result(ago(3 * HOUR) + MIN + 1, "t1", false),
    reply(ago(3 * HOUR) + 2 * MIN, NOTES_QUIET_PLAN),
    user(ago(2 * HOUR), "[job] land 33 test finished"),
    call(ago(2 * HOUR) + MIN, "t2", "Five more jobs are building in parallel."), result(ago(2 * HOUR) + MIN + 1, "t2", true),
    call(ago(2 * HOUR) + 2 * MIN, "t3", "A new job is fixing the test for land 33."), result(ago(2 * HOUR) + 2 * MIN + 1, "t3", false),
    reply(ago(2 * HOUR) + 3 * MIN, "Notes on the wake-up: the job is done."),
  ];
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["seo-vp"] }));
    await writeFile(join(dir, "seo-vp.jsonl"), chat.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const run1 = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(run1.status, 0, run1.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.long_replies, 0, "the owner read the 47-word told text; the 202-word text shows folded in updates");
    assert.equal(health.metrics.slop_replies, 0, "the **AI answers:** labels sit in the folded notes, not in the reply");
    assert.equal(health.metrics.unlinked_job_mentions, 1, "the accepted tell_owner counts, the refused one and the wake-up notes do not");
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "unlinked_job_mentions").map(slice => slice.excerpt), ["A new job is fixing the test for land 33."]);
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
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { metrics: { corrections: 0, repeat_corrections: 0, unlinked_job_mentions: 0, placeholder_todos: 0, dead_hours: 0, unretried_errors: 0, long_replies: 0, slop_replies: 0, off_brief: 0, sieun_pi_breaks: 0, recurred: 0, unfixed_flags: 0, owner_board_asks: 0, no_progress_hours: 0, checkin_ops_dropped: 0, end_state_pct: 100, steps_moving_pct: 100, stuck_step_hours: 0, open_step_hours: 0, stuck_after_checkin: 0, owner_paused_stuck: 0, checkin_not_running: 0, ...NO_MISSES }, flagged: [] });
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

test("chat health: owner directions and status questions are not corrections, a quoted question is not the owner's, a provider error the pool retried is not a sieun-pi break", async () => {
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
    const row = (step: string, cls: string) => `${step} (${cls}) "${step} text" blocked, owner you, last change 9 h ago`;
    const checkIns: [number, string[]][] = [
      [5, [row("p9", "orphan"), row("p10", "stale-chase"), row("p11", "due"), row("p12", "stale-chase")]],
      [4, [row("p9", "stale-chase"), row("p11", "live"), "and 2 more"]],
      [3, [row("p9", "stale-chase"), row("p11", "due"), row("p12", "stale-chase")]],
      [2, [row("p9", "stale-chase"), row("p10", "stale-chase"), row("p11", "due"), row("p12", "stale-chase")]],
    ];
    for (const [hours, rows] of checkIns) lines.push(user(ago(hours * HOUR), `[check-in] What changed:\n- tick ${hours}${openSteps(rows)}`), reply(ago(hours * HOUR) + MIN, ""));
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
    assert.ok(!("stalls_2h" in health.metrics), "the check-in sends no open-steps list any more, so stalls_2h has no source (W44)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: a token hook failure the pool retried is a sieun-pi break only when no later request gets past the hook before the owner speaks, once per turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    // 10-12 KST: every hook failure fell in a lid-closed dark wake (pmset 17:13:37 to 17:13:57, 18:45:26 to 18:45:35, 19:19:00 to 19:19:02).
    // The revive's note landed between the failure and Prime's next try, and the turn ran again at the next full wake: no break. A hook
    // that never gives a token (10-12 19:52, a daemon with no USER read every store as "unknown") keeps failing until the owner asks: one break.
    const hookRetried = `${API_KEY_ERROR} pi-pool: the token hook gave no token; the retry uses a new hook run.`;
    const note = "[check-in] Your last turn failed at 17:11 (Connection error.). Re-check the board and continue.";
    const failed = (at: number) => reply(at, "", "error", { errorMessage: hookRetried });
    const lines: Line[] = [
      user(ago(4 * HOUR), "go on"), failed(ago(4 * HOUR) + 10_000), reply(ago(4 * HOUR) + 25_000, "done"),
      user(ago(3 * HOUR), "and the rest"), failed(ago(3 * HOUR) + 10_000), user(ago(3 * HOUR) + 15_000, note), failed(ago(3 * HOUR) + 30_000),
      failed(ago(3 * HOUR) + 80_000), custom(ago(3 * HOUR) + 90_000, "agent_message", "[agent-message from job] done"),
      reply(ago(3 * HOUR) + 100_000, "", "error", { errorMessage: "Connection error." }), reply(ago(3 * HOUR) + 3 * MIN, "done"),
      user(ago(2 * HOUR), "next"), ...[10, 45, 75].map(second => failed(ago(2 * HOUR) + second * 1_000)), user(ago(2 * HOUR) + 2 * MIN, note),
      failed(ago(2 * HOUR) + 3 * MIN), user(ago(2 * HOUR) + 20 * MIN, "hello?"), reply(ago(2 * HOUR) + 21 * MIN, "back"),
    ];
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-h"] }));
    await writeFile(join(dir, "chat-h.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.sieun_pi_breaks, 1);
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "sieun_pi_breaks").map(slice => slice.at), [ago(2 * HOUR) + 3 * MIN]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: a 429 or a hook failure the pool turned into a wait for the session's slot is not a sieun-pi break unless the turn ends on the hook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    // 10-13: 87 breaks, all pool slot waits. 78 were 429s on accounts the pool knew were limited (Prime slept until the slot, or a check-in restart
    // woke it early), 9 were hook runs that gave no token to a session whose slot was ahead. Every one of those turns ran again by itself.
    const waited = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. [request_id: req_1] pi-pool: v@x (Virev) is limited until 2026-10-08T18:40:00.000Z; this session waits for its slot at 2026-10-08T10:08:00.000Z. Try again in 2 minutes.";
    const refused = "Provider error (400): accept the updated Consumer Terms pi-pool: t@x is out of the pool (needs terms); this session waits for its slot at 2026-10-08T10:20:00.000Z. Try again in 5 minutes.";
    const hookWait = `${API_KEY_ERROR} pi-pool: this session waits for its slot at 2026-10-08T10:06:00.000Z. Try again in 12 minutes.`;
    const note = "[check-in] Your last turn failed at 18:05 (Provider rate limit exceeded (rate_limit_error, 429)). Re-check the board and continue.";
    const failed = (at: number, errorMessage: string) => reply(at, "", "error", { errorMessage });
    const lines: Line[] = [
      user(ago(3 * HOUR), "go"), failed(ago(3 * HOUR) + 10_000, waited), user(ago(3 * HOUR) + 10 * MIN, note), failed(ago(3 * HOUR) + 10 * MIN + 1_000, waited),
      failed(ago(3 * HOUR) + 25 * MIN, refused), failed(ago(3 * HOUR) + 30 * MIN, hookWait), reply(ago(3 * HOUR) + 32 * MIN, "done"),
      user(ago(2 * HOUR), "next"), failed(ago(2 * HOUR) + 10_000, hookWait), user(ago(2 * HOUR) + 20 * MIN, "hello?"), reply(ago(2 * HOUR) + 21 * MIN, "back"),
      user(ago(HOUR), "last"), failed(ago(HOUR) + 10_000, waited), user(ago(HOUR) + 5 * MIN, "still there?"), reply(ago(HOUR) + 6 * MIN, "yes"),
    ];
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-w"] }));
    await writeFile(join(dir, "chat-w.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    // Only the hook wait the owner had to ask past is a break; the provider waits are the provider's, wherever the turn ended.
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "sieun_pi_breaks").map(slice => slice.at), [ago(2 * HOUR) + 10_000]);
    assert.equal(health.metrics.sieun_pi_breaks, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-in quality: a flag left for 4 check-ins in a row counts once in unfixed_flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    const slice = (kind: string, item: string, excerpt: string) => ({ chat: "chat-u", at: 0, kind, excerpt, item });
    const p17 = slice("due_late", "p17", "p17 \"Verify: live rehearsal\" is due since 02:00: act on it or set a new waitUntil");
    const p20 = slice("orphan_steps", "p20", "p20 \"b\" orphan");
    const p30 = slice("due_late", "p30", "p30 \"c\" due");
    const checkIn = (hours: number, flagged: object[], verdict = "missed") => ({ duty: "checkin", at: ago(hours * HOUR), trigger: "schedule", ms: 50, verdict, metrics: {}, summary: "s", flagged });
    // p17 is flagged in 7 measured runs in a row; the skipped and failed runs in between neither extend nor break the streak, and two of them start before the window.
    // p20 is flagged 3 times, cleared, then 3 times again: never 4 in a row. p30 made 5 in a row that ended before the window: fixed, not counted.
    // "nothing" has no item, so it is not a plan step and never counts. A different chat's runs file is not read for this chat.
    const runs = [
      checkIn(40, [p30]), checkIn(38, [p30]), checkIn(36, [p30]), checkIn(34, [p30]), checkIn(32, [p30]), checkIn(30, []),
      checkIn(26, [p17, p20]), checkIn(25, [p17, p20]), checkIn(20, [p17, p20]), checkIn(19, [p17], "skipped"), checkIn(18, [], "error"),
      checkIn(10, [p17]), checkIn(8, [p17, p20]), checkIn(6, [p17, p20, { kind: "x", excerpt: "nothing" }]), checkIn(4, [p17, p20], "met"),
      checkIn(-1, [p20]),
    ];
    await mkdir(join(dir, "duties"), { recursive: true });
    await writeFile(join(dir, "duties", "chat-u.runs.jsonl"), runs.map(line => JSON.stringify(line)).join("\n") + "\nnot json\n");
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-u", "chat-none"] }));
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir, TZ: "UTC" });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.unfixed_flags, 1, "only p17: p20 never made 4 in a row, p30 ended before the window, a missing runs file is zero");
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "unfixed_flags").map(slice => [slice.chat, slice.item, slice.at, slice.excerpt]), [
      ["chat-u", "p17", ago(4 * HOUR), `due_late p17 flagged in 7 check-ins in a row since 2026-10-07 10:00: ${p17.excerpt}`],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-in quality: owner asks to tidy the plan count in owner_board_asks, product asks do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    const asks = ["p40 같은 거 지우고, plan hierarchy 정리해", "organize the plan", "clean up the board", "close p12, it shipped", "board 정리 좀"];
    const notAsks = ["plan the Slack bridge", "the board panel looks cramped", "clean the cache", "fix the board panel layout", "I said \u201cclean up the board\u201d earlier, now ship the bridge"];
    const lines: Line[] = [...asks, ...notAsks].flatMap((text, index) => [user(ago(10 * HOUR) + index * MIN, text), reply(ago(10 * HOUR) + index * MIN + 1_000, "ok")]);
    lines.unshift(user(ago(30 * HOUR), "organize the plan"), reply(ago(30 * HOUR) + 1_000, "ok"));
    lines.push(user(ago(1 * HOUR), "[check-in] What changed:\n- organize the plan"), reply(ago(1 * HOUR) + MIN, ""));
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-o"] }));
    await writeFile(join(dir, "chat-o.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.owner_board_asks, 5, "the five asks in the window; not the product asks, a quoted ask, one before the window, or a check-in line");
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "owner_board_asks").map(slice => slice.excerpt).sort(), [...asks].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health recheck: each fix names the metrics its subject targets, with today's value; one that names none is for a person to judge", () => {
  assert.deepEqual(fixTargets("fix(user-history): long owner replies get a reply rule; text on wake-ups is notes; a stalled step sets waitUntil"), ["long_replies", "off_brief"]);
  assert.deepEqual(fixTargets("fix(user-history): plain derived thread names"), []);
  const metrics = { corrections: 4, dead_hours: 0, unretried_errors: 0, long_replies: 82.8, off_brief: 21, sieun_pi_breaks: 0, recurred: 0, orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0, stalled_steps: 0, go_missing: 0, requirements_missing: 0, goal_gaps: 0, blocked_on_others: 0 };
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

test("chat health duty: the definition parses as a duty with one headline and two judged supporting metrics, and the precheck keeps every other number", async () => {
  const definition: unknown = JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "chat-health.duty.json"), "utf8"));
  const duty = parseDutyInput(definition, "d1", 0);
  assert.deepEqual(duty.metrics.map(metric => [metric.key, metric.op, metric.target, metric.headline ?? false]),
    [["steps_moving_pct", ">=", 100, true], ["repeat_corrections", "<=", 0, false], ["sieun_pi_breaks", "<=", 0, false]], "c75: one headline and at most 3 supporting");
  for (const key of ["scope_misses", "idle_goals", "goals_to_fold", "merges_without_go", "one_session_load", "redundant_heartbeats", "stuck_steps"]) assert.ok(key in NO_MISSES, `${key} stays in the precheck output`);
});

test("check-in quality: the hours with a no-progress check-in count once each in no_progress_hours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    const checkIn = (hours: number, value: number, duty = "checkin") => ({ duty, at: ago(hours * HOUR), trigger: "schedule", ms: 50, verdict: value ? "missed" : "met",
      metrics: { no_progress: { value, target: 0, op: "<=", met: value === 0 } }, summary: "s", flagged: [] });
    // Two no-progress runs in one hour count once; a met run, another duty's run and a run before the window do not count.
    const runs = [checkIn(30, 1), checkIn(5.1, 1), checkIn(5.05, 1), checkIn(3, 0), checkIn(2, 1), checkIn(1, 1, "d1")];
    await mkdir(join(dir, "duties"), { recursive: true });
    await writeFile(join(dir, "duties", "chat-n.runs.jsonl"), runs.map(line => JSON.stringify(line)).join("\n") + "\n");
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-n"] }));
    const output = join(dir, "health.json");
    const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir, TZ: "UTC" });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.no_progress_hours, 2);
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "no_progress_hours").map(slice => slice.chat), ["chat-n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat health: a [job] line after that job's message is a new notice, not off_brief; the same line with no job message between still is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-"));
  try {
    // Crawler VP 10-14: the status ask for lab compose additions at 08:58Z, its answer at 08:59Z, and the ask for its next silent hour at 11:40Z.
    const ask = "[job] lab compose additions has worked on p43 \"Verify a lab copy\" for over an hour with no report: send it one short status ask now";
    const answered = [user(ago(3 * HOUR), ask), reply(ago(3 * HOUR) + MIN, "asked"),
      custom(ago(2.9 * HOUR), "agent_message", "[agent-message from child:lab compose additions]\n\nRound 6 is built."), reply(ago(2.9 * HOUR) + MIN, "noted"),
      user(ago(1 * HOUR), ask), reply(ago(1 * HOUR) + MIN, "asked")];
    const repeated = [user(ago(3 * HOUR), ask), reply(ago(3 * HOUR) + MIN, "asked"),
      custom(ago(2.9 * HOUR), "agent_message", "[agent-message from child:other job]\n\nDone."), reply(ago(2.9 * HOUR) + MIN, "noted"),
      user(ago(1 * HOUR), ask), reply(ago(1 * HOUR) + MIN, "asked")];
    const offBrief = async (lines: Line[]) => {
      await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["chat-a"] }));
      await writeFile(join(dir, "chat-a.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
      const output = join(dir, "out", "health.json");
      const result = run({ OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW), CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir });
      assert.equal(result.status, 0, result.stderr);
      return (JSON.parse(await readFile(output, "utf8")) as PrecheckOutput).metrics.off_brief;
    };
    assert.equal(await offBrief(answered), 0);
    assert.equal(await offBrief(repeated), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

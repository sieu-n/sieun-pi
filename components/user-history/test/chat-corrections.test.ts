import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { applyCorrection, type ChatRef, CORRECTION_TOOL, CorrectionLedger, correctionResult, type Ledger, LEDGER_PROMPT_LINES, ledgerPrompt, matchCorrection,
  parseCorrectionCall, parseLedger, repeatsBetween, themeOverlap, themeTokens } from "../src/chat-corrections.ts";
import { CHAT_BRIEF, CHAT_MODE_ENTRY, REPLY_CAP_NOTE } from "../src/chats.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import { BACKFILL, backfill } from "../scripts/corrections-backfill.ts";
import { unlinkedJobSentence } from "../scripts/duties/job-mentions.ts";

const VP: ChatRef = { id: "vp", name: "dev VP" };
const CI: ChatRef = { id: "ci", name: "VP of CI" };
const add = (words: string, theme: string, rule = "A rule.", enforcedBy = "brief", ref = "abc1234") => parseCorrectionCall({ words, rule, theme, enforcedBy, ref });

test("theme: key words drop stop words and fold plurals; a match shares two key words and half the shorter theme", () => {
  assert.deepEqual(themeTokens("Job reports stay folded in the feed, with links"), ["job", "report", "stay", "folded", "feed", "link"]);
  assert.deepEqual(themeTokens(["replies", "Class"]), ["reply", "class"]);
  const cases: [string, string, boolean][] = [
    ["explanation article link todo reply", "explanation article link todo", true],
    ["mac machine load delegate ops guy", "mac load delegate ops guy", true],
    ["board current todo push stale chase", "board current up to date push", true],
    ["job report folded feed link", "name job thread mention link", false],
    ["job goal subagent output item split", "checkin fan out parallel checks", false],
    ["ui variant pick screenshot inline", "explanation article link todo", false],
    ["aside", "aside", true],
    ["aside login", "aside", true],
    ["aside login", "browser login", false],
  ];
  for (const [a, b, same] of cases) assert.equal(themeOverlap(themeTokens(a), themeTokens(b)) > 0, same, `${a} / ${b}`);
});

test("ledger: a new correction is c1 and active; the same words again change nothing; a matching theme is a repeat that reopens it; a fix sets it active", () => {
  const ledger: Ledger = { corrections: [] };
  const first = applyCorrection(ledger, add("where is the link", "article link todo"), CI, "2026-10-09T10:00:00.000Z");
  assert.equal(first.kind, "added");
  assert.deepEqual(ledger.corrections[0], { id: "c1", at: "2026-10-09T10:00:00.000Z", chat: CI, words: "where is the link", rule: "A rule.", enforcedBy: "brief",
    ref: "abc1234", status: "active", theme: ["article", "link", "todo"], repeats: [] });
  assert.equal(applyCorrection(ledger, add("where  is the link ", "other words"), VP, "2026-10-09T11:00:00.000Z").kind, "known", "a retried call records nothing");
  assert.equal(applyCorrection(ledger, add("ops guy owns the Macs", "mac load ops guy"), VP, "2026-10-09T10:30:00.000Z").kind, "added");
  const again = applyCorrection(ledger, add("where the hell is the link?", "explanation article link"), VP, "2026-10-09T12:00:00.000Z");
  assert.equal(again.kind, "repeat");
  assert.equal(again.entry.id, "c1");
  assert.equal(ledger.corrections.length, 2);
  assert.equal(ledger.corrections[0]!.status, "reopened");
  assert.deepEqual(ledger.corrections[0]!.repeats, [{ at: "2026-10-09T12:00:00.000Z", chat: VP, words: "where the hell is the link?" }]);
  const text = correctionResult(again);
  assert.match(text, /^Repeat of c1 "A rule\.", first given 2026-10-09 in VP of CI; the owner has now repeated it 1 time, so c1 is reopened\./);
  assert.match(text, /A repeat is a sev: the earlier fix \(brief: abc1234\) did not hold\. Fix it in code or a test, not only more prompt text/);
  const fixed = applyCorrection(ledger, parseCorrectionCall({ id: "c1", enforcedBy: "test", ref: "test/x.test.ts" }), VP, "2026-10-09T13:00:00.000Z");
  assert.deepEqual([fixed.entry.status, fixed.entry.enforcedBy, fixed.entry.ref], ["active", "test", "test/x.test.ts"]);
  applyCorrection(ledger, parseCorrectionCall({ id: "c2", status: "retired" }), VP, "2026-10-09T13:00:00.000Z");
  assert.equal(ledger.corrections[1]!.status, "retired");
  assert.equal(matchCorrection(ledger, themeTokens("mac load ops guy"))?.id, "c2", "a retired entry still catches a repeat");
  assert.equal(applyCorrection(ledger, add("new one", "brand fresh theme"), VP, "2026-10-09T14:00:00.000Z").entry.id, "c3");
  assert.throws(() => applyCorrection(ledger, parseCorrectionCall({ id: "c9", status: "retired" }), VP, ""), /No correction c9/);
  assert.throws(() => parseCorrectionCall({ words: "x", rule: "r", theme: "t", enforcedBy: "memory", ref: "r" }), /enforcedBy is one of brief, code, test/);
  assert.throws(() => parseCorrectionCall({ words: "x", rule: "r", theme: "the a", enforcedBy: "code", ref: "r" }), /theme needs key words/);
  assert.deepEqual(parseLedger({ corrections: [{ id: "c1" }, ...ledger.corrections] }), ledger, "a broken entry is dropped, the rest read back");
});

test("ledger: one owner message that repeats two corrections records a repeat on each; the same call again records nothing", () => {
  const ledger: Ledger = { corrections: [] };
  applyCorrection(ledger, add("talk plain, no slop", "reply plain text slop"), VP, "2026-10-09T08:00:00.000Z");
  const words = "unslop, you are talking so much slop. where the hell is the link?";
  assert.equal(applyCorrection(ledger, add(words, "explanation article link todo"), CI, "2026-10-09T10:00:00.000Z").kind, "added");
  const slop = applyCorrection(ledger, add(words, "reply plain text slop"), CI, "2026-10-09T10:00:00.000Z");
  assert.equal(slop.kind, "repeat", "the same words repeat c1 too");
  assert.equal(slop.entry.id, "c1");
  assert.equal(applyCorrection(ledger, add(words, "reply plain text slop"), CI, "2026-10-09T10:01:00.000Z").kind, "known", "a retried call records nothing");
  assert.equal(repeatsBetween(ledger, Date.parse("2026-10-09T00:00:00Z"), Date.parse("2026-10-10T00:00:00Z")).length, 1);
});

test("ledger prompt: active and reopened rules, reopened first then newest, capped; retired ones and an empty ledger give nothing", () => {
  const ledger: Ledger = { corrections: [] };
  assert.equal(ledgerPrompt(ledger), null);
  for (let i = 1; i <= LEDGER_PROMPT_LINES + 3; i++) {
    applyCorrection(ledger, add(`words ${i}`, `theme${i} unique${i}`, `Rule ${i}.`), VP, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  }
  applyCorrection(ledger, add("again", "theme2 unique2"), VP, "2026-10-01T00:00:30.000Z");
  applyCorrection(ledger, parseCorrectionCall({ id: "c43", status: "retired" }), VP, "");
  const lines = ledgerPrompt(ledger)!.split("\n");
  assert.match(lines[0]!, /^\[corrections\] The owner's corrections, live from the ledger\./);
  assert.equal(lines[1], "- c2 (reopened: the owner repeated it 1x; fix it in code or a test) Rule 2.");
  assert.equal(lines[2], "- c42 Rule 42.");
  assert.equal(lines.length, 1 + LEDGER_PROMPT_LINES + 1);
  assert.equal(lines.at(-1), "and 2 older ones in corrections.json");
  assert.ok(!lines.some(line => line.startsWith("- c43 ")));
});

test("ledger file: apply writes corrections.json under the lock and reads back; repeatsBetween counts repeats in a window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corrections-"));
  try {
    const store = new CorrectionLedger(dir);
    assert.deepEqual(await store.read(), { corrections: [] });
    await store.apply(add("first", "mac load ops guy"), VP, "2026-10-09T10:00:00.000Z");
    await store.apply(add("second", "mac load delegate"), CI, "2026-10-09T12:00:00.000Z");
    await store.apply(add("third", "mac load ops"), CI, "2026-10-07T12:00:00.000Z");
    const ledger = await store.read();
    assert.deepEqual(JSON.parse(await readFile(join(dir, "corrections.json"), "utf8")), ledger);
    assert.deepEqual(repeatsBetween(ledger, Date.parse("2026-10-08T12:00:00Z"), Date.parse("2026-10-09T12:00:00Z")).map(({ entry, repeat }) => [entry.id, repeat.words]),
      [["c1", "second"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
/** The extension against a fake pi: its tools, its handlers, and a session that is a chat (`marked`) or not. */
function loadExtension(dataDir: string) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const pi = { registerFlag() {}, registerCommand() {}, registerTool(tool: Tool) { tools.set(tool.name, tool); }, getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const ctx = (chat: boolean) => ({ sessionManager: { getHeader: () => ({ type: "session" }), getEntries: () => chat ? [{ type: "custom", customType: CHAT_MODE_ENTRY }] : [],
    getSessionId: () => "chat-1", getSessionName: () => "dev VP" } });
  const run = async (name: string, event: unknown, chat: boolean) => { let last: unknown; for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx(chat)) ?? last; return last; };
  return { tools, run, ctx };
}

test("extension: correction_add is registered only in a chat; it records a new correction and then a repeat with the sev line", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ext-"));
  try {
    const job = loadExtension(dataDir);
    await job.run("session_start", {}, false);
    assert.ok(!job.tools.has(CORRECTION_TOOL), "a session that is no chat has no correction tool");
    const chat = loadExtension(dataDir);
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    const first = await tool.execute("t1", { words: "wipe it from our plan", rule: "A handed-off step leaves the plan.", theme: "handoff step plan", enforcedBy: "brief", ref: "9953e20" },
      undefined, undefined, chat.ctx(true));
    assert.equal(first.content[0]!.text, "Recorded c1: A handed-off step leaves the plan. (enforced by brief: 9953e20). Every chat reads it from its next model call.");
    const repeat = await tool.execute("t2", { words: "why is it still on the plan", rule: "same", theme: "handoff plan", enforcedBy: "brief", ref: "x" }, undefined, undefined, chat.ctx(true));
    assert.match(repeat.content[0]!.text, /^Repeat of c1 .* A repeat is a sev: .*Fix it in code or a test/);
    const ledger = await new CorrectionLedger(dataDir).read();
    assert.deepEqual(ledger.corrections.map(entry => [entry.id, entry.status, entry.chat, entry.repeats.length]), [["c1", "reopened", { id: "chat-1", name: "dev VP" }, 1]]);
    await assert.rejects(tool.execute("t3", { words: "x" }, undefined, undefined, chat.ctx(true)), /theme is required/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: the context hook puts the live ledger first in a chat's every model call, a new correction from the next call; nothing for other sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ctx-"));
  try {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
    const other = loadExtension(dataDir);
    await other.run("session_start", {}, false);
    const chat = loadExtension(dataDir);
    await chat.run("session_start", {}, true);
    const capped = [{ ...messages[0]!, content: [...messages[0]!.content, { type: "text", text: REPLY_CAP_NOTE }] }];
    assert.deepEqual(await chat.run("context", { messages }, true), { messages: capped }, "no ledger: only the reply cap on the owner's message");
    await new CorrectionLedger(dataDir).apply(add("one", "first theme words", "Rule one."), VP, "2026-10-09T10:00:00.000Z");
    const first = await chat.run("context", { messages }, true) as { messages: { content: { text: string }[] }[] };
    assert.equal(first.messages.length, 2);
    assert.match(first.messages[0]!.content[0]!.text, /^\[corrections\] .*\n- c1 Rule one\.$/);
    await new CorrectionLedger(dataDir).apply(add("two", "second theme here", "Rule two."), CI, "2026-10-09T11:00:00.000Z");
    const next = await chat.run("context", { messages }, true) as { messages: { content: { text: string }[] }[] };
    assert.match(next.messages[0]!.content[0]!.text, /\n- c2 Rule two\.\n- c1 Rule one\.$/, "read live: no reload between the calls");
    assert.equal(await other.run("context", { messages }, false), undefined);
    await writeFile(join(dataDir, "corrections.json"), "not json");
    assert.deepEqual(await chat.run("context", { messages }, true), { messages: capped }, "a broken file fails open: no ledger, the reply cap stays");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a real chat session: a correction written between turns reaches the agent-message turn, which runs no before_agent_start", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "corrections-turns-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "chat-corrections-turns.ts"), dir], { cwd: join(import.meta.dirname, ".."),
      encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH ?? "", HOME: dir, PRIME_AGENT_CODING_AGENT_DIR: join(dir, "agent") } });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { tools: string[]; firstMessages: string[]; beforeAgentStart: { afterOwnerTurn: number; afterAgentMessage: number } };
    assert.ok(seen.tools.includes(CORRECTION_TOOL), seen.tools.join(","));
    assert.equal(seen.firstMessages.length, 2);
    assert.doesNotMatch(seen.firstMessages[0]!, /^\[corrections\]/, "the owner turn ran before the ledger existed");
    assert.match(seen.firstMessages[1]!, /^\[corrections\] .*\n- c1 Written between turns\.$/);
    assert.deepEqual(seen.beforeAgentStart, { afterOwnerTurn: 1, afterAgentMessage: 1 }, "the agent-message turn skipped before_agent_start");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("brief: one bullet tells the chat to record each owner correction in the same turn and to fix a repeat in code or a test", () => {
  const bullet = CHAT_BRIEF.find(line => line.startsWith("Corrections ledger:"));
  assert.ok(bullet);
  assert.match(bullet, /in the same turn the owner corrects you, call `correction_add`/);
  assert.match(bullet, /treat it as a sev: start a job that fixes it in code or a test/);
});

test("unlinked job mentions: a job named as a noun with no job: link anywhere in the message; code, link targets and compound words do not count", () => {
  const cases: [string, string | null][] = [
    ["I started a job for that. It reports in 10 min.", "I started a job for that."],
    ["The job finished.\nNext I will check the board.", "The job finished."],
    ["Two jobs are still running", "Two jobs are still running"],
    ["JOB done", "JOB done"],
    ["The job finished: [report](job:seo daily).", null],
    ["job:seo daily finished, and the other job too", null],
    ["Ran `rlm.spawn(job)` and [x](wiki:jobs/page.html)", null],
    ["job_reply and job-name and jobless", null],
    ["Nothing to report.", null],
    // A job word that points at no one agent job (Chat health 10-09 triage: 12 of 89 flagged messages were only these).
    ["Job reports are folded again and open in full when you click them.", null],
    ["Wiki, file and job paths are clickable now.", null],
    ["On our M1, every CI job runs as the same user, so any job could read the billing keys.", null],
    ["Land 28 is now in its deploy job.", null],
    ["Your split rule is live now: one goal per job, and each job spawns one subagent per output.", null],
    ["Jobs must report back when they finish.", null],
    ["Check-ins now hand bigger work to check-in jobs.", null],
    ["My tools are back. I can't reach my jobs this check-in.", "I can't reach my jobs this check-in."],
    ["The job reports in 10 min.", "The job reports in 10 min."],
    ["Check-ins now hand bigger work to a check-in job.", "Check-ins now hand bigger work to a check-in job."],
  ];
  for (const [text, sentence] of cases) assert.equal(unlinkedJobSentence(text), sentence, text);
});

const NOW = Date.parse("2026-10-09T14:00:00Z");
const line = (message: Record<string, unknown>) => JSON.stringify({ type: "message", timestamp: new Date(message.timestamp as number).toISOString(), message });
test("chat health: repeat_corrections counts ledger repeats in the last 24 h and names entry and chat; unlinked_job_mentions reads owner-turn replies and tell_owner, not wake-up notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corrections-health-"));
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["vp"] }));
    await writeFile(join(dir, "vp.jsonl"), [
      line({ role: "user", content: [{ type: "text", text: "status?" }], timestamp: NOW - 3_600_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "Started a job on it. More soon." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_500_000 }),
      line({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "tell_owner", arguments: { text: "The job is blocked on a login." } }], provider: "p", model: "m",
        stopReason: "toolUse", timestamp: NOW - 3_400_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "The [audit](job:audit run) job finished." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_300_000 }),
      JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[agent-message from w]\n\nDone.", display: true, timestamp: new Date(NOW - 3_200_000).toISOString() }),
      line({ role: "assistant", content: [{ type: "text", text: "Wake-up note: the job is done." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_100_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "Old job note." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 30 * 3_600_000 }),
    ].join("\n") + "\n");
    const store = new CorrectionLedger(dir);
    await store.apply(add("ops guy owns it", "mac load ops guy", "Mac load goes to ops guy."), VP, "2026-10-07T10:00:00.000Z");
    await store.apply(add("didn't i tell you", "mac load delegate"), VP, "2026-10-09T13:06:51.000Z");
    await store.apply(add("long ago", "mac load ops"), CI, "2026-10-07T11:00:00.000Z");
    const output = join(dir, "health.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "duties", "chat-health.ts")], { cwd: join(import.meta.dirname, ".."),
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CHAT_HEALTH_GIT_DIR: "/nonexistent", OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW),
        CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir } });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.repeat_corrections, 1);
    assert.equal(health.metrics.unlinked_job_mentions, 2);
    const flagged = health.flagged ?? [];
    assert.deepEqual(flagged.filter(slice => slice.kind === "repeat_corrections"), [{ chat: "vp", at: Date.parse("2026-10-09T13:06:51.000Z"), kind: "repeat_corrections",
      excerpt: "c1 \"Mac load goes to ops guy.\" repeated in dev VP (first 2026-10-07 in dev VP): didn't i tell you" }]);
    assert.equal(flagged[0]!.kind, "repeat_corrections", "a repeat leads the flagged list");
    assert.deepEqual(flagged.filter(slice => slice.kind === "unlinked_job_mentions").map(slice => [slice.chat, slice.excerpt]).sort(),
      [["vp", "Started a job on it."], ["vp", "The job is blocked on a login."]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backfill: every entry parses; the first run records them oldest first with their repeats, a second run changes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corrections-backfill-"));
  try {
    for (const { at, chat: _chat, ...input } of BACKFILL) { assert.ok(Date.parse(at)); parseCorrectionCall(input); }
    const counts = await backfill(dir);
    assert.equal(counts.added! + counts.repeat!, BACKFILL.length);
    assert.equal(counts.known, 0);
    const before = await readFile(join(dir, "corrections.json"), "utf8");
    assert.deepEqual(await backfill(dir), { added: 0, repeat: 0, known: BACKFILL.length });
    assert.equal(await readFile(join(dir, "corrections.json"), "utf8"), before, "the file is not rewritten");
    const ledger = await new CorrectionLedger(dir).read();
    const reopened = ledger.corrections.filter(entry => entry.status === "reopened").map(entry => entry.repeats.map(repeat => repeat.words)).flat();
    assert.deepEqual(reopened.sort(), ["Mac load -> didn't i tell to delegate", "are you sure this is up to date and you're pushing through?", "where the hell is the link?"]);
    assert.ok(ledger.corrections.some(entry => entry.ref === "294d8e4" && entry.enforcedBy === "test"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

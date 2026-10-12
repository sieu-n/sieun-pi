import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { applyCorrection, briefCorrections, type ChatRef, CORRECTION_TOOL, CorrectionLedger, correctionResult, JOB_RULES, jobLedgerPrompt, type Ledger, LEDGER_PROMPT_LINES, ledgerPrompt,
  matchCorrection, OUTSIDE_ACTION_RULE, parseCorrectionCall, parseLedger, READ_RULE, repeatsBetween, themeOverlap, themeTokens } from "../src/chat-corrections.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { CHAT_MODE_ENTRY, REPLY_CAP_NOTE } from "../src/chat-guard.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import { unlinkedJobSentence } from "../src/shared/job-mentions.ts";

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
  assert.equal(ledgerPrompt(ledger, new Set()), null);
  for (let i = 1; i <= LEDGER_PROMPT_LINES + 3; i++) {
    applyCorrection(ledger, add(`words ${i}`, `theme${i} unique${i}`, `Rule ${i}.`), VP, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  }
  applyCorrection(ledger, add("again", "theme2 unique2"), VP, "2026-10-01T00:00:30.000Z");
  applyCorrection(ledger, parseCorrectionCall({ id: "c43", status: "retired" }), VP, "");
  const lines = ledgerPrompt(ledger, new Set())!.split("\n");
  assert.match(lines[0]!, /^\[corrections\] The owner's corrections in force, live from the ledger\./);
  assert.ok(lines[0]!.includes(READ_RULE), "the header says how to read a rule in full");
  assert.equal(lines[1], "- c2 (reopened: the owner repeated it 1x; fix it in code or a test) Rule 2.");
  assert.equal(lines[2], "- c42 Rule 42.");
  assert.equal(lines.length, 1 + LEDGER_PROMPT_LINES + 1);
  assert.equal(lines.at(-1), "and 2 older ones");
  assert.ok(!lines.some(line => line.startsWith("- c43 ")));
});

test("ledger prompt: a rule the brief holds is its id and one landed code or a test holds is its id and theme, each group on one line; a pending or brief-only rule and a reopened one stay in full", () => {
  const ledger: Ledger = { corrections: [] };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  applyCorrection(ledger, add("w1", "outside email send owner ok", "No email without the owner's ok."), VP, at(1));
  applyCorrection(ledger, add("w2", "duty name plain words", "Duties have plain names.", "code", "abc1234"), VP, at(2));
  applyCorrection(ledger, add("w3", "cache ratio drop test", "A cache fix ships with a test.", "test", "pending cache job"), VP, at(3));
  applyCorrection(ledger, add("w4", "frontend split time loop", "Frontend work is 70% build."), VP, at(4));
  applyCorrection(ledger, add("w5", "staging deploy confirm ask merge", "Staging needs no ok.", "code", "abc1234"), VP, at(5));
  applyCorrection(ledger, add("w6", "staging deploy confirm", "x"), VP, at(6));
  assert.deepEqual(ledgerPrompt(ledger, briefCorrections(["Nothing goes outside without his ok (c1)."]))!.split("\n").slice(1), [
    "- c5 (reopened: the owner repeated it 1x; fix it in code or a test) Staging needs no ok.",
    "- c4 Frontend work is 70% build.",
    "- c3 A cache fix ships with a test.",
    "Held by the brief: c1",
    "Held by code or tests: c2 duty name plain",
  ]);
  assert.deepEqual([...briefCorrections(["a (c47) and c12, not abc12 or c5x"])], ["c47", "c12"]);
});

test("job ledger prompt: only the rules that bind jobs, in full, after the outside-action rule and the pointer to the rest", () => {
  const ledger: Ledger = { corrections: [] };
  for (let i = 1; i <= 50; i++) applyCorrection(ledger, add(`words ${i}`, `theme${i} unique${i}`, `Rule ${i}.`), VP, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  const lines = jobLedgerPrompt(ledger).split("\n");
  assert.equal(lines[0], jobLedgerPrompt(null));
  assert.ok(lines[0]!.includes(OUTSIDE_ACTION_RULE) && lines[0]!.includes(READ_RULE));
  assert.deepEqual(lines.slice(1), [...JOB_RULES].map(id => Number(id.slice(1))).sort((a, b) => b - a).map(n => `- c${n} Rule ${n}.`));
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
type Entry = { id: string; type: string; customType?: string; data?: unknown; message?: unknown; content?: string };
function loadExtension(dataDir: string, session: { header?: object; id?: string; name?: string; branch?: Entry[] } = {}) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const branch: Entry[] = [...session.branch ?? []];
  const pi = { registerFlag() {}, registerCommand() {}, registerTool(tool: Tool) { tools.set(tool.name, tool); }, getActiveTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: unknown) { branch.push({ id: `e${branch.length}`, type: "custom", customType, data }); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const ctx = (chat: boolean) => ({ sessionManager: { getHeader: () => session.header ?? { type: "session" }, getEntries: () => chat ? [{ type: "custom", customType: CHAT_MODE_ENTRY }] : [],
    getBranch: () => branch, getSessionId: () => session.id ?? "chat-1", getSessionName: () => session.name ?? "dev VP" } });
  const run = async (name: string, event: unknown, chat: boolean) => {
    if (name === "context") for (const message of (event as { messages: unknown[] }).messages) {
      if (!branch.some(entry => entry.type === "message" && entry.message === message)) branch.push({ id: `e${branch.length}`, type: "message", message });
    }
    let last: unknown; for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx(chat)) ?? last; return last;
  };
  return { tools, run, ctx };
}

test("extension: correction_add is registered only in a chat; it records a new correction and then a repeat with the sev line", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ext-"));
  try {
    const job = loadExtension(dataDir);
    await job.run("session_start", {}, false);
    assert.ok(!job.tools.has(CORRECTION_TOOL), "a session that is no chat has no correction tool");
    const chat = loadExtension(dataDir, { branch: [owner("wipe it from our plan"), owner("why is it still on the plan")] });
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    const schema = JSON.stringify({ name: tool.name, description: (tool as unknown as { description: string }).description, parameters: (tool as unknown as { parameters: unknown }).parameters });
    assert.ok(schema.length <= 700, `correction_add schema is ${schema.length} chars; keep tool texts lean`);
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

let entries = 0;
const owner = (text: string): Entry => ({ id: `o${entries++}`, type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: entries } });
const LAND_33 = "Never re-push a land-33 branch name tonight.";
/** The c53 entry as the live ledger held it on 10-12, before the Crawler VP recorded Fable's words as a repeat of it. */
const C53 = { id: "c53", at: "2026-10-12T10:44:26.987Z", chat: { id: "01a1180e-6567-747f-bf44-452520ebdd1b", name: "VP of CI" },
  words: "you know it's your duty? UNBLOCK CI, make it hourly, fix current issue\np90 wait time < 10 minute\nrun time < 10minute",
  rule: "The VP of CI unblocks CI itself every hour.", enforcedBy: "brief", ref: "pending ci hourly duty", status: "active", theme: ["unblock", "ci", "hourly", "duty"], repeats: [] };
/** The Crawler VP transcript around 21:55Z on 10-12: the owner's own messages, a check-in, Fable's agent message and the chat relaying it, all holding the land-33 line but the owner's. */
const crawlerVp = (): Entry[] => [
  owner("strip every single every evyer evyer fucking single arbitrary overly safe limit completely existense wipe streamline simplify code from the entire codebase."),
  owner("it's totally ok to ramp up things!!! we are still at testing stage!!!"),
  owner(`[check-in] What changed:\n- Fable: ${LAND_33}`),
  { id: "f1", type: "custom_message", customType: "agent_message", content: `[agent-message from Untitled]\n\nFrom 01a0cc5e (Fable). LIMITS r8: the two new commits go to land 34 on a NEW branch name. ${LAND_33}` },
  { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: `Fable's ruling: ${LAND_33}` }], timestamp: 99 } },
];

test("extension: correction_add refuses words no owner message holds, so Fable's land-33 line in the Crawler VP is no repeat of c53", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-owner-"));
  try {
    const file = join(dataDir, "corrections.json");
    await writeFile(file, JSON.stringify({ corrections: [C53] }, null, 2));
    const before = await readFile(file, "utf8");
    const chat = loadExtension(dataDir, { id: "01a115e2-9544-7204-b8db-8ce4d5319048", name: "Crawler VP", branch: crawlerVp() });
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    // The call the Crawler VP made at 21:58Z.
    await assert.rejects(tool.execute("t1", { rule: "Never re-push a branch whose run is in the current land set.", words: LAND_33,
      ref: "Fable 10-12 21:5xZ ruling (not the owner)", theme: "ci", enforcedBy: "brief" }, undefined, undefined, chat.ctx(true)),
      /not in any owner message of this chat\. Quote the owner exactly, or do not record it/);
    assert.equal(await readFile(file, "utf8"), before, "the ledger is unchanged: no repeat on c53");
    await assert.rejects(tool.execute("t2", { rule: "A new rule.", words: LAND_33, ref: "x", theme: "land branch name re-push", enforcedBy: "brief" },
      undefined, undefined, chat.ctx(true)), /Quote the owner exactly/, "a new correction in another agent's words is refused too");
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: correction_add takes the owner's exact words with other whitespace, quotes or case, a part of one message, and a repeat in them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-owner-"));
  try {
    await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [C53] }));
    const chat = loadExtension(dataDir, { name: "Crawler VP", branch: [...crawlerVp(), owner("never say \"done\" before the CI run is green, unblock CI hourly")] });
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    const call = (words: string, theme: string) => tool.execute("t", { words, rule: "A rule.", theme, enforcedBy: "brief", ref: "x" }, undefined, undefined, chat.ctx(true));
    const added = await call("It\u2019s totally ok to ramp up\n  things!!!", "ramp up testing stage");
    assert.match(added.content[0]!.text, /^Recorded c54: /);
    const repeat = await call("Never say \u201cdone\u201d before the CI run is green, UNBLOCK CI hourly", "unblock ci hourly");
    assert.match(repeat.content[0]!.text, /^Repeat of c53 /);
    const ledger = await new CorrectionLedger(dataDir).read();
    assert.deepEqual(ledger.corrections.map(entry => [entry.id, entry.status, entry.repeats.length]), [["c53", "reopened", 1], ["c54", "active", 0]]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: tell_owner takes an optional reply_to, and an unknown id goes through with no error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "tell-owner-ext-"));
  try {
    const chat = loadExtension(dataDir);
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get("tell_owner") as Tool & { parameters: { properties: Record<string, { type: string }>; required: string[] } };
    assert.equal(tool.parameters.properties.reply_to?.type, "string");
    assert.deepEqual(tool.parameters.required, ["text"], "reply_to is optional");
    const told = await tool.execute("t1", { text: "The audit is done and nothing failed.", reply_to: "no-such-id" }, undefined, undefined, chat.ctx(true));
    assert.equal(told.content[0]!.text, "told the owner");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: correction changes append after the stable prefix and survive retries, retirement and a broken ledger", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ctx-"));
  try {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
    const other = loadExtension(dataDir);
    await other.run("session_start", {}, false);
    const chat = loadExtension(dataDir);
    await chat.run("session_start", {}, true);
    const capped = [{ ...messages[0]!, content: [...messages[0]!.content, { type: "text", text: "[message id: 1]" }, { type: "text", text: REPLY_CAP_NOTE }] }];
    assert.deepEqual(await chat.run("context", { messages }, true), { messages: capped });
    const store = new CorrectionLedger(dataDir);
    await store.apply(add("one", "first theme words", "Rule one."), VP, "2026-10-09T10:00:00.000Z");
    const first = await chat.run("context", { messages }, true) as { messages: { content: { text: string }[] }[] };
    assert.deepEqual(first.messages[0], capped[0]);
    assert.match(first.messages[1]!.content[0]!.text, /^\[corrections\] .*\n- c1 Rule one\.$/);
    assert.deepEqual(await chat.run("context", { messages }, true), first, "same ledger yields the same payload");
    await store.apply(add("two", "second theme here", "Rule two."), CI, "2026-10-09T11:00:00.000Z");
    const next = await chat.run("context", { messages }, true) as typeof first;
    assert.deepEqual(next.messages.slice(0, 2), first.messages, "new rule cannot rewrite an earlier message");
    assert.match(next.messages[2]!.content[0]!.text, /- c2 Rule two\./);
    await store.apply(parseCorrectionCall({ id: "c1", status: "retired" }), VP);
    const retired = await chat.run("context", { messages }, true) as typeof first;
    assert.deepEqual(retired.messages.slice(0, 3), next.messages);
    assert.match(retired.messages[3]!.content[0]!.text, /Remove c1 from the active rules\./);
    assert.equal(await other.run("context", { messages }, false), undefined);
    await writeFile(join(dataDir, "corrections.json"), "not json");
    assert.deepEqual(await chat.run("context", { messages }, true), retired, "bad reads keep the last delivered rules");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: every job under a chat, a duty root too, reads the live ledger after the outside-action rule; the next call sees a new correction", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-job-"));
  try {
    const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
    const file = (name: string) => join(dataDir, `${name}.jsonl`);
    await writeFile(file("chat"), lines([{ type: "session", id: "chat-1" }, { type: "session_info", name: "VP of CI" }, { type: "custom", customType: CHAT_MODE_ENTRY, data: { v: 1 } }]));
    await writeFile(file("job"), lines([{ type: "session", id: "job-1", parentSession: file("chat"), rlmDepth: 1 }]));
    await writeFile(file("duty"), lines([{ type: "session", id: "duty-1" }, { type: "session_info", name: "check-in VP of CI 14:52" }]));
    await writeFile(file("plain"), lines([{ type: "session", id: "plain-1" }, { type: "session_info", name: "a terminal thread" }]));
    await jobRegistry(join(dataDir, "chat-jobs.json")).add(["duty-1"], "VP of CI");
    const sessions = {
      subagent: { header: { type: "session", parentSession: file("chat"), rlmDepth: 1 }, id: "job-1", name: "w62" },
      "subagent of a subagent": { header: { type: "session", parentSession: file("job"), rlmDepth: 2 }, id: "helper-1", name: "helper" },
      "duty root": { header: { type: "session" }, id: "duty-1", name: "check-in VP of CI 14:52" },
      "subagent of the duty root": { header: { type: "session", parentSession: file("duty"), rlmDepth: 1 }, id: "duty-helper", name: "mailer" },
    };
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
    const jobs = await Promise.all(Object.entries(sessions).map(async ([label, session]) => {
      const job = loadExtension(dataDir, session);
      await job.run("session_start", {}, false);
      return { label, job };
    }));
    for (const { label, job } of jobs) {
      const seen = await job.run("context", { messages }, false) as { messages: { content: { text: string }[] }[] };
      assert.equal(seen.messages[1]!.content[0]!.text, jobLedgerPrompt(null), label);
      assert.deepEqual(seen.messages.slice(0, 1), messages, `${label}: no reply cap in a job`);
    }
    // A job reads only the rules that bind jobs (JOB_RULES), so the new rule is c37, written straight to the file.
    await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [{ id: "c37", at: "2026-10-10T07:11:00.000Z", chat: CI, words: "이메일 보내기 전에 먼저 물어봐",
      rule: "No email without the owner's ok.", enforcedBy: "code", ref: "abc1234", status: "active", theme: ["email", "vendor"], repeats: [] }] }));
    for (const { label, job } of jobs) {
      const seen = await job.run("context", { messages }, false) as { messages: { content: { text: string }[] }[] };
      assert.match(seen.messages[2]!.content[0]!.text, /^\[corrections\] Update.*\n- c37 No email without the owner's ok\.$/, `${label}: read live, no reload`);
    }
    await writeFile(join(dataDir, "corrections.json"), "not json");
    const broken = await jobs[0]!.job.run("context", { messages }, false) as { messages: { content: { text: string }[] }[] };
    assert.match(broken.messages[1]!.content[0]!.text, /c37: .*todo\. /, "an unreadable ledger keeps the outside-action rule");
    const outside = {
      "plain root": { header: { type: "session" }, id: "plain-1", name: "a terminal thread" },
      "subagent of a plain root": { header: { type: "session", parentSession: file("plain"), rlmDepth: 1 }, id: "p-1", name: "x" },
      "subagent of a missing file": { header: { type: "session", parentSession: file("gone"), rlmDepth: 1 }, id: "g-1", name: "y" },
    };
    for (const [label, session] of Object.entries(outside)) {
      const other = loadExtension(dataDir, session);
      await other.run("session_start", {}, false);
      assert.equal(await other.run("context", { messages }, false), undefined, label);
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

type TurnsSeen = { tools: string[]; turnMessages: string[][]; beforeAgentStart: { afterOwnerTurn: number; afterAgentMessage: number } };
/** Runs test/chat-corrections-turns.ts as a chat or a registered duty job in a child process and returns what its model saw. */
async function realTurns(mode: "chat" | "duty"): Promise<TurnsSeen> {
  const dir = await mkdtemp(join(tmpdir(), "corrections-turns-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "chat-corrections-turns.ts"), dir, mode], { cwd: join(import.meta.dirname, ".."),
      encoding: "utf8", timeout: 90_000, env: { PATH: process.env.PATH ?? "", HOME: dir, PRIME_AGENT_CODING_AGENT_DIR: join(dir, "agent") } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as TurnsSeen;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a real chat session: a correction reaches an agent-message wake without changing the first request's prefix", { timeout: 120_000 }, async () => {
  const seen = await realTurns("chat");
  assert.ok(seen.tools.includes(CORRECTION_TOOL), seen.tools.join(","));
  assert.equal(seen.turnMessages.length, 2);
  assert.ok(!seen.turnMessages[0]!.some(text => text.startsWith("[corrections]")));
  assert.deepEqual(seen.turnMessages[1]!.slice(0, seen.turnMessages[0]!.length), seen.turnMessages[0]);
  assert.ok(seen.turnMessages[1]!.some(text => /^\[corrections\] .*\n- c1 Written between turns\.$/.test(text)));
  assert.deepEqual(seen.beforeAgentStart, { afterOwnerTurn: 1, afterAgentMessage: 1 });
});

test("a real duty job session: its outside-action rule persists and a new correction follows the stable prefix", { timeout: 120_000 }, async () => {
  const seen = await realTurns("duty");
  assert.ok(!seen.tools.includes(CORRECTION_TOOL), seen.tools.join(","));
  assert.equal(seen.turnMessages.length, 2);
  assert.ok(seen.turnMessages[0]!.some(text => text === jobLedgerPrompt(null)));
  assert.deepEqual(seen.turnMessages[1]!.slice(0, seen.turnMessages[0]!.length), seen.turnMessages[0]);
  assert.ok(seen.turnMessages[1]!.some(text => /\[corrections\] Update.*\n- c37 Written between turns\.$/.test(text)));
  assert.deepEqual(seen.beforeAgentStart, { afterOwnerTurn: 1, afterAgentMessage: 1 });
});

test("brief: one line tells the chat to record each owner correction in the same turn; the board skill's corrections reference holds the rest", async () => {
  assert.ok(CHAT_BRIEF.includes("When the owner corrects how you work, apply it now and record it with `correction_add` in the same turn."));
  const reference = await readFile(new URL("../../../skills/board/references/corrections.md", import.meta.url), "utf8");
  assert.match(reference, /In the same turn, call `correction_add` with the owner's exact words/);
  assert.match(reference, /When the tool says repeat, treat it as a sev\. Start a job that fixes it in code or a test/);
  assert.match(reference, /board\.corrections\("c12"\)/);
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
test("chat health: repeat_corrections counts ledger repeats in the last 24 h and names entry and chat; unlinked_job_mentions reads tell_owner, and owner-turn text only on a turn with no tell_owner (the page folds it into updates), not wake-up notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corrections-health-"));
  try {
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["vp"] }));
    await writeFile(join(dir, "vp.jsonl"), [
      line({ role: "user", content: [{ type: "text", text: "status?" }], timestamp: NOW - 3_600_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "Started a job on it. More soon." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_500_000 }),
      line({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "tell_owner", arguments: { text: "The job is blocked on a login." } }], provider: "p", model: "m",
        stopReason: "toolUse", timestamp: NOW - 3_400_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "The [audit](job:audit run) job finished." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_300_000 }),
      line({ role: "user", content: [{ type: "text", text: "and the rest?" }], timestamp: NOW - 3_250_000 }),
      line({ role: "assistant", content: [{ type: "text", text: "Two jobs are left." }], provider: "p", model: "m", stopReason: "stop", timestamp: NOW - 3_240_000 }),
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
      [["vp", "The job is blocked on a login."], ["vp", "Two jobs are left."]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


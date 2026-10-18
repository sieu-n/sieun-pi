import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { applyCorrection, briefCorrections, CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, type ChatRef, CORRECTION_TOOL, CorrectionLedger, correctionResult, JOB_RULES, jobLedgerPrompt, type Ledger, ledgerPrompt,
  matchCorrection, OUTSIDE_ACTION_RULE, ownerSaid, parseCorrectionCall, parseLedger, READ_RULE, repeatsBetween, themeOverlap, themeTokens } from "../src/chat-corrections.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { CHAT_MODE_ENTRY } from "../src/chat-guard.ts";
import { jobRegistry } from "../src/chat-sources.ts";

const VP: ChatRef = { id: "vp", name: "dev VP" };
const CI: ChatRef = { id: "ci", name: "VP of CI" };
const add = (words: string, theme: string, rule = "A rule.", enforcedBy = "brief", ref = "abc1234") => parseCorrectionCall({ words, rule, theme, enforcedBy, ref });

test("c81: a new correction with no enforcedBy is held by the brief, and a bad one is still refused", () => {
  const call = parseCorrectionCall({ words: "make sure these are enforced", rule: "A wiki write runs in a subagent.", theme: "llm wiki subagent write", ref: "pending" });
  assert.equal(call.kind === "add" && call.input.enforcedBy, "brief");
  assert.throws(() => parseCorrectionCall({ words: "x", rule: "y", theme: "a b", enforcedBy: "gate", ref: "z" }), /enforcedBy is one of brief, code, test/);
});

test("theme: key words drop stop words and fold plurals; a match shares two key words past the generic ones and half the shorter theme", () => {
  assert.deepEqual(themeTokens("Job reports stay folded in the feed, with links"), ["job", "report", "stay", "folded", "feed", "link"]);
  assert.deepEqual(themeTokens(["replies", "Class"]), ["reply", "class"]);
  const cases: [string, string, boolean][] = [
    ["explanation article link todo reply", "explanation article link todo", true],
    ["mac machine load delegate ops guy", "mac load delegate ops guy", true],
    ["board current todo push stale chase", "board current up to date push", true],
    ["job report folded feed link", "name job thread mention link", false],
    ["job goal subagent output item split", "checkin fan out parallel checks", false],
    ["ui variant pick screenshot inline", "explanation article link todo", false],
    ["aside", "aside", false],
    ["aside login", "aside", false],
    ["aside login", "browser login", false],
    ["board", "board title plain readable", false],
    ["board plan scratchpad note", "board plan title note", false],
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
  const again = applyCorrection(ledger, add("where the hell is the link?", "explanation article link", "An explanation article gets a link."), VP, "2026-10-09T12:00:00.000Z");
  assert.equal(again.kind, "repeat");
  assert.equal(again.entry.id, "c1");
  assert.equal(ledger.corrections.length, 2);
  assert.equal(ledger.corrections[0]!.status, "reopened");
  assert.deepEqual(ledger.corrections[0]!.repeats, [{ at: "2026-10-09T12:00:00.000Z", chat: VP, words: "where the hell is the link?" }]);
  const text = correctionResult(again);
  assert.match(text, /^Repeat of c1 "A rule\.", first given 2026-10-09 in VP of CI; the owner has now repeated it 1 time, so c1 is reopened\./);
  assert.match(text, /The earlier fix \(brief: abc1234\) did not hold\. Make the smallest change that gets agents to follow the rule: first a brief, skill or prompt line/);
  assert.match(text, /a code gate only when measured repeats show the text did not hold, with those repeats named in the fix \(c81\)/);
  assert.doesNotMatch(text, /Fix it in code or a test|enforcedBy "code" or "test"/);
  const fixed = applyCorrection(ledger, parseCorrectionCall({ id: "c1", enforcedBy: "test", ref: "test/x.test.ts" }), VP, "2026-10-09T13:00:00.000Z");
  assert.deepEqual([fixed.entry.status, fixed.entry.enforcedBy, fixed.entry.ref], ["active", "test", "test/x.test.ts"]);
  applyCorrection(ledger, parseCorrectionCall({ id: "c2", status: "retired" }), VP, "2026-10-09T13:00:00.000Z");
  assert.equal(ledger.corrections[1]!.status, "retired");
  assert.equal(matchCorrection(ledger, themeTokens("mac load ops guy"), "Mac load goes to ops guy.")?.id, "c2", "a retired entry still catches a repeat");
  assert.equal(applyCorrection(ledger, add("new one", "brand fresh theme"), VP, "2026-10-09T14:00:00.000Z").entry.id, "c3");
  assert.throws(() => applyCorrection(ledger, parseCorrectionCall({ id: "c9", status: "retired" }), VP, ""), /No correction c9/);
  assert.throws(() => parseCorrectionCall({ words: "x", rule: "r", theme: "t", enforcedBy: "memory", ref: "r" }), /enforcedBy is one of brief, code, test/);
  assert.throws(() => parseCorrectionCall({ words: "x", rule: "r", theme: "the a", enforcedBy: "code", ref: "r" }), /theme needs key words/);
  assert.deepEqual(parseLedger({ corrections: [{ id: "c1" }, ...ledger.corrections] }), ledger, "a broken entry is dropped, the rest read back");
});

test("ledger: one owner message that repeats two corrections records a repeat on each; the same call again records nothing", async () => {
  const ledger: Ledger = { corrections: [] };
  applyCorrection(ledger, add("talk plain, no slop", "reply plain text slop"), VP, "2026-10-09T08:00:00.000Z");
  const words = "unslop, you are talking so much slop. where the hell is the link?";
  assert.equal(applyCorrection(ledger, add(words, "explanation article link todo"), CI, "2026-10-09T10:00:00.000Z").kind, "added");
  const slop = applyCorrection(ledger, add(words, "reply plain text slop", "Replies are plain text with no slop."), CI, "2026-10-09T10:00:00.000Z");
  assert.equal(slop.kind, "repeat", "the same words repeat c1 too");
  assert.equal(slop.entry.id, "c1");
  assert.equal(applyCorrection(ledger, add(words, "reply plain text slop", "Replies are plain text with no slop."), CI, "2026-10-09T10:01:00.000Z").kind, "known", "a retried call records nothing");
  assert.equal((await repeatsBetween(ledger, Date.parse("2026-10-09T00:00:00Z"), Date.parse("2026-10-10T00:00:00Z"), async () => [words])).length, 1);
});

test("repeatsBetween counts a repeat only when the owner wrote its words in that chat: ops guy's own notes on c59 and c4 (10-12) are no repeats", async () => {
  const OPS: ChatRef = { id: "ops", name: "ops guy (+observability)" };
  const ledger: Ledger = { corrections: [] };
  applyCorrection(ledger, add("Your brief for blog batches live check breaks the Jobs rule", "job brief word verbatim",
    "A job brief quotes only owner messages sent to this chat, word for word."), VP, "2026-10-12T14:27:59.460Z");
  applyCorrection(ledger, add("ran vercel login, next time for these can you consult Aside and login auth yourself?", "cli login aside oauth browser",
    "A CLI or service login, GitHub included, is finished in the owner's Aside browser with Google or GitHub sign-in."), OPS, "2026-10-09T10:12:31.466Z");
  applyCorrection(ledger, add("stop making up these bullshit rules on waiting", "invented waiting rule overly careful gate",
    "Do not invent waiting rules, extra review rounds or safety gates; act directly and ship."), CI, "2026-10-12T06:01:43.213Z");
  const note59 = "(brief check, twice on 10-12) \"have it your duty to have usable mac.\" is not in any owner message.";
  const note4 = "(owner rule recalled by the release owner and the global harness note: agents never do a GitHub sign-in in Aside)";
  const owner47 = "look, be fucking aggressive. it's ok to break things. just make it work. NEVER wait for something, or ask for my permission to push to Github etc.";
  assert.equal(applyCorrection(ledger, add(note59, "brief owner words duty alert", "The brief check matches owner quotes only against recent owner messages."),
    OPS, "2026-10-12T20:38:04.615Z").kind, "repeat");
  assert.equal(applyCorrection(ledger, add(note4, "github sign in aside login", "Never sign in to GitHub in Aside; use CI job tokens."), OPS, "2026-10-12T17:53:56.511Z").kind, "repeat");
  assert.equal(applyCorrection(ledger, add(owner47, "invented waiting rule overly",
    "The VP of CI acts aggressively on CI speed: it pushes its own fixes to GitHub without waiting for another thread's go."), CI, "2026-10-12T14:12:31.885Z").kind, "repeat");
  const said: Record<string, string[]> = {
    ops: ["have it your duty to have usable mac.", "[brief check] Your brief for [wiki down at five](job:wiki down at five) breaks the Jobs rule"],
    ci: ["then are you working actively on it?", `${owner47.replace("fucking", "Fucking")}\n`],
  };
  const asked: string[] = [];
  const repeats = await repeatsBetween(ledger, Date.parse("2026-10-12T14:07:00Z"), Date.parse("2026-10-13T14:07:00Z"), async chat => { asked.push(chat); return said[chat] ?? []; });
  assert.deepEqual(repeats.map(({ entry, repeat }) => [entry.id, repeat.chat.id]), [["c3", "ci"]], "only the owner's own words in that chat count, with case and spaces folded");
  assert.deepEqual(asked.sort(), ["ci", "ops"], "each chat's owner messages are read once");
  const c32 = "이름 이딴식으로 짓지 말고, \n\ngit rules are enforced, \nci works and isn't annoying\n\n이런식으로";
  assert.ok(ownerSaid(`${c32} [screenshot of the duties panel: CI guarantees, Repo rules, CI design review]`, [c32]), "a note in brackets is the chat's, not a word the owner must have written");
  assert.ok(!ownerSaid("[screenshot of the duties panel]", [c32]) && !ownerSaid("ci works [x] and stop asking", [c32]), "the words around the note must be the owner's");
});

test("ledger prompt: every active and reopened rule, reopened first then newest, with no count cut; retired ones and an empty ledger give nothing", () => {
  const ledger: Ledger = { corrections: [] };
  assert.equal(ledgerPrompt(ledger, new Set()), null);
  for (let i = 1; i <= 43; i++) {
    applyCorrection(ledger, add(`words ${i}`, `theme${i} unique${i}`, `Rule ${i}.`), VP, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  }
  applyCorrection(ledger, add("again", "theme2 unique2", "Rule 2 on theme2 and unique2."), VP, "2026-10-01T00:00:30.000Z");
  applyCorrection(ledger, parseCorrectionCall({ id: "c43", status: "retired" }), VP, "");
  const lines = ledgerPrompt(ledger, new Set())!.split("\n");
  assert.match(lines[0]!, /^\[corrections\] The owner's corrections in force, live from the ledger\./);
  assert.ok(lines[0]!.includes(READ_RULE), "the header says how to read a rule in full");
  assert.equal(lines[1], "- c2 Rule 2.");
  assert.equal(lines[2], "- c42 Rule 42.");
  assert.equal(lines.length, 1 + 42, "all 42 rules in force show; only the retired c43 is left out");
  assert.ok(lines.slice(1).every(line => /^- c\d+ /.test(line)), "every line after the header is one rule");
  assert.ok(!lines.some(line => line.startsWith("- c43 ")));
});

test("ledger prompt: a rule the brief names or landed code holds is left out, and every other rule, reopened first, is its id and first sentence", () => {
  const ledger: Ledger = { corrections: [] };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  applyCorrection(ledger, add("w1", "outside email send owner ok", "No email without the owner's ok."), VP, at(1));
  applyCorrection(ledger, add("w2", "duty name plain words", "Duties have plain names.", "code", "abc1234"), VP, at(2));
  applyCorrection(ledger, add("w3", "cache ratio drop test", "A cache fix ships with a test.", "test", "pending cache job"), VP, at(3));
  applyCorrection(ledger, add("w4", "frontend split time loop", "Frontend work is 70% build. The rest is review and tests."), VP, at(4));
  applyCorrection(ledger, add("w5", "staging deploy confirm ask merge", "Staging needs no ok.", "code", "abc1234"), VP, at(5));
  applyCorrection(ledger, add("w6", "staging deploy confirm", "Staging deploys need no confirm."), VP, at(6));
  assert.deepEqual(ledgerPrompt(ledger, briefCorrections(["Nothing goes outside without his ok (c1)."]))!.split("\n").slice(1), [
    "- c5 Staging needs no ok.",
    "- c4 Frontend work is 70% build.",
    "- c3 A cache fix ships with a test.",
  ]);
  assert.deepEqual([...briefCorrections(["a (c47) and c12, not abc12 or c5x"])], ["c47", "c12"]);
});

test("job ledger prompt: only the rules that bind jobs, one short line each, after the outside-action rule and the pointer to the rest", () => {
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
    await store.apply(add("second", "mac load delegate", "Mac load goes to ops guy."), CI, "2026-10-09T12:00:00.000Z");
    await store.apply(add("third", "mac load ops", "Mac load goes to ops guy."), CI, "2026-10-07T12:00:00.000Z");
    const ledger = await store.read();
    assert.deepEqual(JSON.parse(await readFile(join(dir, "corrections.json"), "utf8")), ledger);
    assert.deepEqual((await repeatsBetween(ledger, Date.parse("2026-10-08T12:00:00Z"), Date.parse("2026-10-09T12:00:00Z"), async () => ["second"]))
      .map(({ entry, repeat }) => [entry.id, repeat.words]), [["c1", "second"]]);
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

test("extension: correction_add is registered only in a chat; it records a new correction and then a repeat with the sev line", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ext-"));
  try {
    const job = loadExtension(dataDir);
    await job.run("session_start", {}, false);
    assert.ok(!job.tools.has(CORRECTION_TOOL), "a session that is no chat has no correction tool");
    const chat = loadExtension(dataDir, { branch: [owner("wipe it from our plan"), owner("why is it still on the plan")] });
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    const schema = JSON.stringify({ name: tool.name, description: (tool as unknown as { description: string }).description, parameters: (tool as unknown as { parameters: unknown }).parameters });
    if (schema.length > 700) t.diagnostic(`[soft cap] correction_add schema is ${schema.length} chars, past its 700 target; keep tool texts lean`);
    const first = await tool.execute("t1", { words: "wipe it from our plan", rule: "A handed-off step leaves the plan.", theme: "handoff step leaves plan", enforcedBy: "brief", ref: "9953e20" },
      undefined, undefined, chat.ctx(true));
    assert.equal(first.content[0]!.text, "Recorded c1: A handed-off step leaves the plan. (enforced by brief: 9953e20). Every chat reads it from its next model call. " +
      "When this turn ends the service refines the global harness on it with /refine, so do not call refine.run for it.");
    const repeat = await tool.execute("t2", { words: "why is it still on the plan", rule: "A handed-off step leaves the plan at once.", theme: "handoff plan leave", enforcedBy: "brief", ref: "x" },
      undefined, undefined, chat.ctx(true));
    assert.match(repeat.content[0]!.text, /^Repeat of c1 .* did not hold\. Make the smallest change .*\(c81\)/);
    const ledger = await new CorrectionLedger(dataDir).read();
    assert.deepEqual(ledger.corrections.map(entry => [entry.id, entry.status, entry.chat, entry.repeats.length]), [["c1", "reopened", { id: "chat-1", name: "dev VP" }, 1]]);
    await assert.rejects(tool.execute("t3", { words: "x" }, undefined, undefined, chat.ctx(true)), /theme is required/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: a chat clean-room.ts opened records its corrections in the scratch ledger, never the real one", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-clean-room-"));
  try {
    await writeFile(join(dataDir, CLEAN_ROOM_CHATS_FILE), JSON.stringify({ ids: ["room-1"] }));
    const chat = loadExtension(dataDir, { id: "room-1", name: "pi-pool queue waits", branch: [owner("stop using bold in your replies")] });
    await chat.run("session_start", {}, true);
    const result = await chat.tools.get(CORRECTION_TOOL)!.execute("t1", { words: "stop using bold in your replies", rule: "Replies use no bold.", theme: "bold replies",
      ref: "brief" }, undefined, undefined, chat.ctx(true));
    assert.match(result.content[0]!.text, /^Recorded c1: Replies use no bold\./);
    assert.deepEqual((await new CorrectionLedger(dataDir).read()).corrections, []);
    assert.deepEqual((await new CorrectionLedger(dataDir, CLEAN_ROOM_CORRECTIONS_FILE).read()).corrections.map(entry => [entry.id, entry.chat.id]), [["c1", "room-1"]]);
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

test("extension: correction_add records the owner's words, and a repeat in them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-owner-"));
  try {
    await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [C53] }));
    const chat = loadExtension(dataDir, { name: "Crawler VP", branch: [...crawlerVp(), owner("never say \"done\" before the CI run is green, unblock CI hourly")] });
    await chat.run("session_start", {}, true);
    const tool = chat.tools.get(CORRECTION_TOOL)!;
    const call = (words: string, theme: string, rule = "A rule.") => tool.execute("t", { words, rule, theme, enforcedBy: "brief", ref: "x" }, undefined, undefined, chat.ctx(true));
    const added = await call("It\u2019s totally ok to ramp up\n  things!!!", "ramp up testing stage");
    assert.match(added.content[0]!.text, /^Recorded c54: /);
    const repeat = await call("Never say \u201cdone\u201d before the CI run is green, UNBLOCK CI hourly", "unblock ci hourly", "The VP of CI unblocks CI every hour.");
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

test("extension: the corrections block goes in once and stays put through a new rule, a retirement and a broken ledger", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "corrections-ctx-"));
  try {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
    const other = loadExtension(dataDir);
    await other.run("session_start", {}, false);
    const chat = loadExtension(dataDir);
    await chat.run("session_start", {}, true);
    const capped = [{ ...messages[0]!, content: [...messages[0]!.content, { type: "text", text: "[message id: 1]" }] }];
    assert.deepEqual(await chat.run("context", { messages }, true), { messages: capped });
    const store = new CorrectionLedger(dataDir);
    await store.apply(add("one", "first theme words", "Rule one."), VP, "2026-10-09T10:00:00.000Z");
    const first = await chat.run("context", { messages }, true) as { messages: { content: { text: string }[] }[] };
    assert.deepEqual(first.messages[0], capped[0]);
    assert.match(first.messages[1]!.content[0]!.text, /^\[corrections\] .*\n- c1 Rule one\.$/);
    assert.deepEqual(await chat.run("context", { messages }, true), first, "same ledger yields the same payload");
    await store.apply(add("two", "second theme here", "Rule two."), CI, "2026-10-09T11:00:00.000Z");
    assert.deepEqual(await chat.run("context", { messages }, true), first, "a new rule is not resent into a running context");
    await store.apply(parseCorrectionCall({ id: "c1", status: "retired" }), VP);
    assert.deepEqual(await chat.run("context", { messages }, true), first, "nor is a retirement");
    assert.equal(await other.run("context", { messages }, false), undefined);
    await writeFile(join(dataDir, "corrections.json"), "not json");
    assert.deepEqual(await chat.run("context", { messages }, true), first, "bad reads keep the delivered rules");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("extension: every job under a chat, a duty root too, gets the outside-action rule once at its start, and a later correction is not resent", async () => {
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
      assert.deepEqual(seen.messages.slice(0, 1), messages, `${label}: no message id in a job`);
    }
    // A job reads only the rules that bind jobs (JOB_RULES), so the new rule is c37, written straight to the file.
    await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [{ id: "c37", at: "2026-10-10T07:11:00.000Z", chat: CI, words: "이메일 보내기 전에 먼저 물어봐",
      rule: "No email without the owner's ok.", enforcedBy: "code", ref: "abc1234", status: "active", theme: ["email", "vendor"], repeats: [] }] }));
    for (const { label, job } of jobs) {
      const seen = await job.run("context", { messages }, false) as { messages: { content: { text: string }[] }[] };
      assert.equal(seen.messages.length, 2, `${label}: the block went in once`);
      assert.equal(seen.messages[1]!.content[0]!.text, jobLedgerPrompt(null), label);
    }
    const late = loadExtension(dataDir, { header: { type: "session", parentSession: file("chat"), rlmDepth: 1 }, id: "job-2", name: "w63" });
    await late.run("session_start", {}, false);
    const started = await late.run("context", { messages }, false) as { messages: { content: { text: string }[] }[] };
    assert.match(started.messages[1]!.content[0]!.text, /\n- c37 No email without the owner's ok\.$/, "a job that starts later reads the live ledger");
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

test("a real duty job session: its outside-action rule persists and a correction written between turns is not resent", { timeout: 120_000 }, async () => {
  const seen = await realTurns("duty");
  assert.ok(!seen.tools.includes(CORRECTION_TOOL), seen.tools.join(","));
  assert.equal(seen.turnMessages.length, 2);
  assert.ok(seen.turnMessages[0]!.some(text => text === jobLedgerPrompt(null)));
  assert.deepEqual(seen.turnMessages[1]!.slice(0, seen.turnMessages[0]!.length), seen.turnMessages[0]);
  assert.ok(!seen.turnMessages[1]!.slice(seen.turnMessages[0]!.length).some(text => text.startsWith("[corrections]")));
  assert.deepEqual(seen.beforeAgentStart, { afterOwnerTurn: 1, afterAgentMessage: 1 });
});

test("brief: one line tells the chat to record each owner correction in the same turn; the board skill's corrections reference holds the rest", async () => {
  assert.ok(CHAT_BRIEF.includes("When the owner corrects how you work, apply it now and record it with `correction_add` in the same turn."));
  const reference = await readFile(new URL("../../../skills/board/references/corrections.md", import.meta.url), "utf8");
  assert.match(reference, /In the same turn, call `correction_add` with the owner's exact words/);
  assert.match(reference, /When the tool says repeat, the earlier fix did not hold\. Make the smallest change that gets agents to follow the rule, first a brief, skill or prompt line/);
  assert.match(reference, /board\.corrections\("c12"\)/);
});


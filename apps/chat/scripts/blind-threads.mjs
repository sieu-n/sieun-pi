#!/usr/bin/env node
/**
 * The blind check for two asks in two threads (skills/sw-factory/SKILL.md, "Reactions and threads" rules 5 and 6, and "How agents should
 * write in a room" rule 4): a fresh test agent in a fresh test channel gets a measuring ask whose answer holds several numbers, then a quick
 * question as a new root post while the first ask runs, with no steering. So the older ask is answered second, in a turn its work thread's
 * report wakes, with a newer root below it.
 * The owner wrote "slop slop slop" on 11-21 (#dev-app-search-prospect p33) under a thread where Search product, misc. had put its answer to
 * his older p9 in the thread of his newer p11, and had crammed three numbers into one run-on line (p13).
 *
 *   node apps/chat/scripts/blind-threads.mjs [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184] [--keep] [--dm]
 *
 * Checks, per run:
 * 1. The quick question gets its answer in its own thread.
 * 2. The measuring ask's answer, the agent post whose last version carries the numbers, sits in the measuring ask's thread and came last.
 * 3. No agent post is a root post, and the quick question's thread holds no agent post about the measuring ask.
 * 4. That answer's last version opens with a top line of at most 20 words, and no line outside a `- ` item crams several results, by the
 *    rule comm-guard.ts holds posts and edits with (`crammedLine`). A count of raw numbers per line failed a top line of one sentence, "it's
 *    small, about 10k lines of app code plus 10k of tests, and the suite runs in about 39 s.", whose results all sat in its bullets.
 * The run also records whether the measuring answer came as a new post or as the last edit of a checklist, since only a new post in the
 * report's turn tests apps/chat's default for a post with no reply_to.
 * With --dm the asks go to the agent's DM, with a second quick question 4 s after the first, so both queue behind the agent's turn. Each
 * answer must answer its own post (`answers`). On 11-21 a contact finder blind check's answer to p2 was stored as answers=p3, because p2's
 * input entered the comm thread after p3 was posted and its message id named p3 by time (apps/chat `RoomPost.inputs`).
 *
 * The measuring ask waits up to 40 min, since blind-follow-up.mjs's research task took up to 27 min. The asks are about an upstream clone we
 * only read (~/code/symphony), never sw factory, because fresh agents read sw-factory asks as feedback (agent-factory memory, 11-20).
 */
import { appendFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { crammedLine } from "../../../packages/pi-host/src/durable/comm-guard.ts";

const { values } = parseArgs({ options: { cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" }, keep: { type: "boolean" }, dm: { type: "boolean" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const cwd = values.cwd ?? join(homedir(), "code/symphony");
const MEASURE_MS = 40 * 60_000;
const QUESTION_GAP_MS = 45_000;
const POLL_MS = 2_000;

const MEASURE = "we're sizing symphony before we adopt it. can you measure how many source files, lines of code and test files the elixir app has, and how long its test suite takes to run?";
const QUESTION = "unrelated quick one, what license is symphony under?";
const QUESTION2 = "and which elixir version does it need?";
const QUESTION2_GAP_MS = 4_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One API call; while a release restarts the chat server the call is retried for up to 5 min. */
async function call(method, path, body) {
  const until = Date.now() + 5 * 60_000;
  let response;
  for (;;) {
    try {
      response = await fetch(`${server}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status < 500 || Date.now() > until) break;
    } catch (error) {
      if (Date.now() > until) throw error;
    }
    await sleep(3_000);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A text with its links, code and ids taken out, so a number in a URL, a path, a post id such as p12, a sha or a date does not count. */
const plain = text => text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ")
  .replace(/\b(?:p|t|d|c)\d+\b/g, " ").replace(/\b[0-9a-f]{7,40}\b/g, " ").replace(/\b\d{4}-\d\d-\d\d\b|\b\d\d?:\d\d\b|\b\d\d?-\d\d\b/g, " ");
/** The numbers in a line: each run of digits with its separators and range, such as 1,850-2,210, 2 cents or 73.9%, and "175 of 178" as one. */
const numbers = line => (plain(line).replace(/\d[\d,.]*\s+of\s+(?=\d)/g, "").match(/\$?\d[\d,.]*(?:\s?[-–]\s?\$?\d[\d,.]*)?/g) ?? []).length;
/** The sentences in a line: each run that ends in ., ! or ? before a space or the end. */
const sentences = line => plain(line).split(/(?<=[.!?])\s+(?=\S)/).filter(s => /\w/.test(s)).length;
const LIST = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const words = text => text.split(/\s+/).filter(Boolean).length;

/** A post's shape: its top line's words and the worst line outside a list item. */
function shape(text) {
  const lines = text.split("\n").filter(l => l.trim() && !/^>/.test(l.trim()));
  const prose = lines.filter(l => !LIST.test(l));
  return {
    topWords: words(lines[0] ?? ""), bullets: lines.some(l => LIST.test(l)), numbers: numbers(text),
    worstLine: Math.max(0, ...prose.map(numbers)), worstSentences: Math.max(0, ...prose.map(sentences)),
  };
}

const piHost = () => { try { return readlinkSync(join(homedir(), ".local/share/pi-host/current")); } catch { return null; } };
const piHostAtStart = piHost();
const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const agent = await call("POST", "/api/agents", { name: `blind threads ${stamp}`, test: true, cwd, ...(values.host ? { host: values.host } : {}) });
const room = values.dm ? agent.room : (await call("POST", "/api/rooms", { kind: "channel", name: `blind-threads-${stamp}`, agenda: "", members: [agent.id], test: true })).id;
console.log(`agent ${agent.id} room ${room} cwd ${cwd}`);

const record = async () => (await call("GET", "/api/agents?test=1")).find(a => a.id === agent.id);
async function allPosts() {
  const top = (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
  const out = [...top];
  for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
const isAgent = post => post.author?.id === agent.id;

const versions = new Map();
let latest = [];
async function poll() {
  const now = Date.now();
  latest = await allPosts();
  for (const p of latest) {
    const seen = versions.get(p.id) ?? [];
    if (seen.at(-1)?.text !== p.text) seen.push({ at: seen.length ? now : Math.min(now, p.at ?? now), text: p.text });
    versions.set(p.id, seen);
  }
}
async function waitFor(ms, done) {
  const until = Date.now() + ms;
  for (;;) {
    await poll();
    if (done() || Date.now() > until) return done();
    await sleep(POLL_MS);
  }
}

const send = async (text, key) => (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-threads-${stamp}-${key}` })).item;
const inThread = id => latest.filter(p => isAgent(p) && (p.threadRoot === id || p.answers === id));
const lastAt = p => versions.get(p.id)?.at(-1)?.at ?? p.at;
/** The agent post whose last version carries the measuring answer: the one with the most numbers, 3 or more. */
const measured = () => latest.filter(p => isAgent(p) && numbers(p.text) >= 3 && !/\[ \]/.test(p.text)).sort((a, b) => numbers(b.text) - numbers(a.text))[0];
/** Whether the agent's 👀 is off a post, its sign that the post's work ended, since agents no longer mark a thread done (c236). */
const eyesOff = id => !(latest.find(p => p.id === id)?.reactions ?? []).some(r => r.emoji === "👀" && r.by.some(b => b.id === agent.id));

const started = Date.now();
let line;
try {
  const measure = await send(MEASURE, "measure");
  // In a DM the quick questions follow within seconds, so they reach the comm thread while its first turn still runs and queue behind it.
  await waitFor(values.dm ? QUESTION2_GAP_MS : QUESTION_GAP_MS, () => false);
  const question = await send(QUESTION, "question");
  let question2;
  if (values.dm) {
    await waitFor(QUESTION2_GAP_MS, () => false);
    question2 = await send(QUESTION2, "question2");
  }
  await waitFor(MEASURE_MS, () => inThread(question.id).length > 0 && (!question2 || inThread(question2.id).length > 0) && measured() !== undefined && (eyesOff(measure.id) || lastAt(measured()) > Date.now() - 60_000));
  // A last edit or 👀 coming off can follow the answer by seconds.
  await waitFor(45_000, () => false);

  const answer = measured();
  const questionReplies = inThread(question.id);
  const roots = latest.filter(p => isAgent(p) && !p.threadRoot);
  const answerShape = answer ? shape(answer.text) : null;
  const firstQuestionReplyAt = questionReplies[0]?.at ?? null;
  const viaEdit = answer ? (versions.get(answer.id)?.length ?? 1) > 1 || answer.at < (firstQuestionReplyAt ?? 0) : null;
  const answersOwn = id => latest.some(p => isAgent(p) && p.answers === id);
  const checks = values.dm ? [
    ["the first quick question got a post that answers it", answersOwn(question.id)],
    ["the second quick question got a post that answers it", Boolean(question2) && answersOwn(question2.id)],
    ["the measuring answer answers the measuring ask", answer?.answers === measure.id],
    ["no line outside a list item crams several results", Boolean(answer) && crammedLine(answer.text) === undefined],
  ] : [
    ["the quick question got an answer in its own thread", questionReplies.some(p => p.threadRoot === question.id)],
    ["the measuring answer came", Boolean(answer)],
    ["the measuring answer sits in the measuring ask's thread", answer?.threadRoot === measure.id],
    ["the measuring answer came after the quick answer", Boolean(answer) && firstQuestionReplyAt !== null && lastAt(answer) > firstQuestionReplyAt],
    ["no agent post is a root post", roots.length === 0],
    ["the quick question's thread holds no measuring answer", questionReplies.every(p => numbers(p.text) < 3)],
    ["the measuring answer's top line has at most 20 words", answerShape !== null && answerShape.topWords <= 20],
    ["no line outside a list item crams several results", Boolean(answer) && crammedLine(answer.text) === undefined],
  ];
  line = {
    at: new Date().toISOString(), piHost: { start: piHostAtStart, end: piHost() }, agent: agent.id, room, cwd, seconds: Math.round((Date.now() - started) / 1000),
    thread: `${server}/#/c/${room}?thread=${measure.id}`, measure: measure.id, question: question.id, question2: question2?.id ?? null, answer: answer?.id ?? null, viaEdit, shape: answerShape,
    posts: latest.map(p => ({ id: p.id, author: isAgent(p) ? "agent" : "owner", threadRoot: p.threadRoot ?? null, answers: p.answers ?? null, versions: (versions.get(p.id) ?? []).map(v => v.text) })),
    checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok),
  };
  for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}${p.answers ? ` answers ${p.answers}` : ""} ${p.versions.length} versions: ${(p.versions.at(-1) ?? "").slice(0, 200).replace(/\n/g, " / ")}`);
  console.log(`measuring answer ${answer?.id ?? "none"} via ${viaEdit === null ? "n/a" : viaEdit ? "checklist edit" : "new post"}`);
  for (const [name, ok] of checks) console.log(`${ok ? "pass" : "FAIL"} ${name}`);
  console.log(line.pass ? "PASS" : "FAIL");
} catch (error) {
  line = { at: new Date().toISOString(), agent: agent.id, room, error: String(error?.stack ?? error), pass: false };
  console.error(error);
} finally {
  if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
  if (!values.keep) {
    const thread = (await record().catch(() => undefined))?.thread;
    if (thread) await call("PATCH", `/api/c/${thread}`, { archived: true }).catch(e => console.error(`archive agent: ${e}`));
    if (!values.dm) await call("PATCH", `/api/rooms/${room}`, { archived: true }).catch(e => console.error(`archive room: ${e}`));
  }
}
process.exit(line?.pass ? 0 : 1);

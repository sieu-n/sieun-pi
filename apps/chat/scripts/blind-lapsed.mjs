#!/usr/bin/env node
/**
 * The blind check for a comm thread's trimmed history (pi-host `cache-shape.ts` `leanHistory`): once its 1 h cache lapsed, a comm thread's
 * earlier turns lose their thinking and their tool texts over 1,500 characters, which can cut the end of a long hand-over it sent its work
 * thread. A fresh test agent gets a several-checks task in a fresh test channel, with no steering. Once its thread reads done, the script
 * waits until the comm thread has made no model call for 66 min, then asks in that thread about the last thing the agent handed over.
 *
 *   node apps/chat/scripts/blind-lapsed.mjs [--cwd <project>] [--out <file.jsonl>] [--server http://127.0.0.1:5184] [--keep]
 *     [--agent <id> --room <id> --task <post id>]
 *
 * With --agent, --room and --task the run picks up a run a stop cut off after its task: a pi-host restart adds no model call to the comm
 * thread, so the idle wait goes on from its last call.
 *
 * Checks:
 * 1. The comm thread handed the task over with more than 1,500 characters, so the trim cut it (else the run is n/a).
 * 2. The first model call after the follow-up read under 20k tokens from the cache, so the follow-up ran on the cold, trimmed path.
 * 3. The follow-up got a reply, and the thread read done again.
 * 4. The checklist reply to the task still holds its final text, and every reply to the follow-up ends with no open `- [ ]` item.
 * Whether the follow-up answer is right, or asks the work thread instead of making something up, is read by hand against the hand-over and
 * the work thread's report, which the output line holds.
 */
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const { values } = parseArgs({ options: { cwd: { type: "string" }, out: { type: "string" }, server: { type: "string" }, keep: { type: "boolean" }, agent: { type: "string" }, room: { type: "string" }, task: { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const cwd = values.cwd ?? join(homedir(), "code/symphony");
const threadsDir = join(homedir(), ".prime/agent/pi-host/durable/threads");
const TASK = "before we adopt symphony for the team, can you check a few things: how it picks up issues from linear, how it keeps each agent's workspace apart, " +
  "what it does when an agent run fails or hangs, and what it records per run so we can see token spend?";
const FOLLOW_UP = "what was the last thing on the list you had checked, and what exactly came back on it?";
/** pi-host's COLD_MS is 65 min; a minute more makes the follow-up's request cold. */
const IDLE_MS = 66 * 60_000;
const TASK_MS = 45 * 60_000;
const FOLLOW_MS = 30 * 60_000;
const OPEN_ITEM = /^[ \t]*[-*+] \[ \] \S/m;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const agent = values.agent ? { id: values.agent } : await call("POST", "/api/agents", { name: `blind lapsed ${stamp}`, test: true, cwd });
const room = values.room ?? (await call("POST", "/api/rooms", { kind: "channel", name: `blind-lapsed-${stamp}`, agenda: "", members: [agent.id], test: true })).id;
console.log(`agent ${agent.id} room ${room} cwd ${cwd}`);

const record = async () => (await call("GET", "/api/agents?test=1")).find(a => a.id === agent.id);
async function posts() {
  const top = (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
  const out = [...top];
  for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
const isAgent = post => post.author?.id === agent.id;
const send = async (text, key, threadRoot) => (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-lapsed-${stamp}-${key}`, ...(threadRoot ? { threadRoot } : {}) })).item;
async function waitFor(ms, done) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value || Date.now() > until) return value;
    await sleep(5_000);
  }
}

/** The model messages of conversation 1 of a thread on this box, oldest first. */
function messages(thread) {
  const file = join(threadsDir, `${thread}.sqlite`);
  if (!thread || !existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries WHERE conversation_id = 1 ORDER BY id").all().flatMap(row => JSON.parse(row.record).model ?? []);
  } finally {
    db.close();
  }
}
const commOf = async () => (await record())?.comm?.find(c => c.room === room)?.thread;

let line;
try {
  const task = values.task ? (await posts()).find(p => p.id === values.task) : await send(TASK, "task");
  // The items API shows a done root's flag as `done: { by, at }` and leaves it out while the thread is open.
  const done = async id => Boolean((await posts()).find(p => p.id === id)?.done);
  // A picked-up run waited for its task before the stop, so it reads the done mark once.
  const taskDone = values.task ? await done(task.id) : await waitFor(TASK_MS, () => done(task.id));
  const before = await posts();
  const checklist = before.find(p => isAgent(p) && p.answers === task.id);
  const comm = await commOf();
  const handOvers = messages(comm).flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall" && /agent_message\.send/.test(String(b.arguments?.code ?? ""))) : [])
    .map(b => String(b.arguments.code));
  const handOver = handOvers.at(-1) ?? "";
  const lastCall = () => Math.max(0, ...messages(comm).filter(m => m.role === "assistant").map(m => m.timestamp ?? 0));
  await waitFor(IDLE_MS + 30 * 60_000, () => Date.now() - lastCall() >= IDLE_MS);
  const idleMinutes = Math.round((Date.now() - lastCall()) / 60_000);

  const followUp = await send(FOLLOW_UP, "follow-up", task.id);
  const replied = async () => (await posts()).some(p => isAgent(p) && p.seq > followUp.seq) && await done(task.id);
  const followDone = await waitFor(FOLLOW_MS, replied);
  await sleep(30_000);
  const after = await posts();
  const followReplies = after.filter(p => isAgent(p) && p.seq > followUp.seq);
  const firstCall = messages(comm).find(m => m.role === "assistant" && (m.timestamp ?? 0) >= followUp.at);
  const checklistNow = after.find(p => p.id === checklist?.id);
  const work = (await record())?.thread;
  const report = messages(work).filter(m => m.role === "assistant").flatMap(m => m.content.filter(b => b.type === "toolCall" && /agent_message\.send/.test(String(b.arguments?.code ?? "")))
    .map(b => ({ at: m.timestamp, code: String(b.arguments.code).slice(0, 4000) })));

  const checks = [
    ["the task thread read done", taskDone],
    ["the hand-over ran over 1,500 characters, so the trim cut it", handOver.length > 1500 ? true : null],
    ["the follow-up's first call read under 20k tokens from the cache", firstCall ? (firstCall.usage?.cacheRead ?? 0) < 20_000 : false],
    ["the follow-up got a reply and the thread read done again", Boolean(followDone) && followReplies.length > 0],
    ["the checklist reply keeps its final text", Boolean(checklist) && checklistNow?.text === checklist.text],
    ["no reply to the follow-up ends with an open item", followReplies.every(p => !OPEN_ITEM.test(p.text))],
  ];
  line = {
    at: new Date().toISOString(), agent: agent.id, room, comm, work, idleMinutes, thread: `${server}/#/c/${room}?thread=${task.id}`,
    handOver, handOverChars: handOver.length, checklist: checklist?.text ?? null, firstCallUsage: firstCall?.usage ?? null,
    followUp: FOLLOW_UP, followReplies: followReplies.map(p => p.text), reports: report,
    checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok !== false),
  };
  console.log(`hand-over, ${handOver.length} chars, ends:\n${handOver.slice(-700)}\n`);
  console.log(`follow-up after ${idleMinutes} min idle; first call usage ${JSON.stringify(firstCall?.usage ?? null)}`);
  for (const text of line.followReplies) console.log(`reply:\n${text}\n`);
  for (const [name, ok] of checks) console.log(`${ok === null ? "n/a " : ok ? "pass" : "FAIL"} ${name}`);
  console.log(line.pass ? "PASS" : "FAIL");
} catch (error) {
  line = { at: new Date().toISOString(), agent: agent.id, room, error: String(error?.stack ?? error), pass: false };
  console.error(error);
} finally {
  if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
  if (!values.keep) {
    const thread = (await record().catch(() => undefined))?.thread;
    if (thread) await call("PATCH", `/api/c/${thread}`, { archived: true }).catch(e => console.error(`archive agent: ${e}`));
    await call("PATCH", `/api/rooms/${room}`, { archived: true }).catch(e => console.error(`archive room: ${e}`));
  }
}
process.exit(line?.pass ? 0 : 1);

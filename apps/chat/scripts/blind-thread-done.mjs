#!/usr/bin/env node
/**
 * The blind thread done check of the sw-factory skill (skills/sw-factory/SKILL.md, "Reactions and threads"): a fresh test agent gets a real
 * question in a fresh test channel with no steering, and the run checks the done flag the owner asked for on 11-20 in #sw-factory-build
 * (p113): "끝난 쓰레드를 Check로 살짝 흐릿하게 만들수 있으면 좋겠다. make it a boolean flag that applies to the root thread message, and
 * view/editable by agent too".
 *
 *   node apps/chat/scripts/blind-thread-done.mjs [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *
 * 1. The owner posts a question, the agent answers in its thread and calls set_thread_done, and the root reads done.
 * 2. The owner posts a follow-up in that thread, and the root reads open right after it (apps/chat reopens a done thread on an owner reply).
 * 3. The agent answers the follow-up in the thread and marks the thread done again.
 * 4. No post of the agent's carries the agent's ✅, and no post keeps its 👀 at the end.
 *
 * Waits: an answer waits up to 25 min, as in blind-reactions.mjs, since an agent may hand the work to its work thread. After an answer the
 * run waits up to 3 min for the done mark, since the comm thread sets it in the same turn after its post and 👀 comes off after the post too.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const ANSWER_MS = 25 * 60_000;
const DONE_MS = 3 * 60_000;
const POLL_MS = 1_500;
const EYES = "👀";
const CHECK = "✅";

const QUESTION = "where does the chat server keep a room's posts?";
const FOLLOW_UP = "and how big is that file today?";

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

const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const agent = await call("POST", "/api/agents", { name: `blind done ${stamp}`, test: true, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.host ? { host: values.host } : {}) });
const room = (await call("POST", "/api/rooms", { kind: "channel", name: `blind-done-${stamp}`, agenda: "", members: [agent.id], test: true })).id;
console.log(`agent ${agent.id} room ${room}`);

const roots = async () => (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
async function allPosts() {
  const top = await roots();
  const out = [...top];
  for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
const rootDone = async id => (await roots()).find(p => p.id === id)?.done;
const mine = (post, emoji) => (post?.reactions ?? []).some(r => r.emoji === emoji && r.by.some(b => b.id === agent.id));
const answersOf = (posts, id) => posts.filter(p => p.author?.id === agent.id && p.answers === id);

/** The set_thread_done calls of the agent's comm thread for the room, as `{message, done}`. */
async function doneCalls() {
  const record = (await call("GET", "/api/agents?test=1")).find(a => a.id === agent.id);
  const thread = record?.comm?.find(c => c.room === room)?.thread;
  if (!thread) return [];
  const calls = [];
  for (const item of (await call("GET", `/api/c/${thread}/items?limit=200`)).items) for (const step of item.steps ?? []) {
    if (step.kind !== "tool" || step.name !== "set_thread_done") continue;
    try {
      const args = JSON.parse(step.summary);
      calls.push({ message: String(args.message_id ?? ""), done: args.done === true });
    } catch { /* a summary cut short names nothing */ }
  }
  return calls;
}

async function waitFor(ms, done) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value || Date.now() > until) return value;
    await sleep(POLL_MS);
  }
}

const send = async (text, key, threadRoot) => (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-done-${stamp}-${key}`, ...(threadRoot ? { threadRoot } : {}) })).item;

const question = await send(QUESTION, "question");
const askedAt = Date.now();
await waitFor(ANSWER_MS, async () => answersOf(await allPosts(), question.id).length > 0);
const answerSeconds = Math.round((Date.now() - askedAt) / 1000);
const doneAfterAnswer = Boolean(await waitFor(DONE_MS, () => rootDone(question.id)));
const callsAfterAnswer = await doneCalls();

const followUp = await send(FOLLOW_UP, "follow-up", question.id);
const openAfterFollowUp = !(await rootDone(question.id));
const followedAt = Date.now();
await waitFor(ANSWER_MS, async () => answersOf(await allPosts(), followUp.id).length > 0);
const followUpSeconds = Math.round((Date.now() - followedAt) / 1000);
const doneAtEnd = await waitFor(DONE_MS, () => rootDone(question.id));
// 👀 comes off after the post, so the last read waits a little past the done mark.
await sleep(30_000);
const posts = await allPosts();
const calls = await doneCalls();

const checks = [
  ["the question got an answer in its thread", answersOf(posts, question.id).some(p => p.threadRoot === question.id)],
  ["the agent called set_thread_done with done true after the answer", callsAfterAnswer.some(c => c.done)],
  ["the root read done after the answer", doneAfterAnswer],
  ["the root read open right after the owner's follow-up", openAfterFollowUp],
  ["the follow-up got an answer in the thread", answersOf(posts, followUp.id).some(p => p.threadRoot === question.id)],
  ["the root read done again at the end", Boolean(doneAtEnd)],
  ["no ✅ by the agent anywhere", posts.every(p => !mine(p, CHECK))],
  ["no post keeps the agent's 👀 at the end", posts.every(p => !mine(p, EYES))],
  ["no agent post is a root post", posts.every(p => p.author?.id !== agent.id || p.threadRoot)],
];
const line = {
  at: new Date().toISOString(), room, agent: agent.id, answerSeconds, followUpSeconds, doneCalls: calls, doneAtEnd: doneAtEnd ?? null,
  posts: posts.map(p => ({ id: p.id, author: p.author?.id === agent.id ? "agent" : "owner", threadRoot: p.threadRoot, answers: p.answers, reactions: (p.reactions ?? []).map(r => `${r.emoji} ${r.by.map(b => b.name).join(",")}`), done: p.done ?? null, text: p.text })),
  checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok),
};
for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}${p.answers ? ` answers ${p.answers}` : ""} [${p.reactions.join(" · ")}]${p.done ? " [done]" : ""} ${p.text.slice(0, 160).replace(/\n/g, " ")}`);
console.log(`set_thread_done calls: ${JSON.stringify(calls)}`);
console.log(`${line.pass ? "PASS" : "FAIL"}: ${checks.filter(([, ok]) => !ok).map(([n]) => `failed: ${n}`).join(", ") || "every check holds"}`);
if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
process.exit(line.pass ? 0 : 1);

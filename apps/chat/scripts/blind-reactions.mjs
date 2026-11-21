#!/usr/bin/env node
/**
 * The blind reactions and threads check of the sw-factory skill (skills/sw-factory/SKILL.md, "Reactions and threads"): a fresh test agent
 * gets the owner's real kinds of posts in a fresh test channel and in its DM, with no steering, and the run checks what the owner asked for
 * on 11-20 in #sw-factory-build: "시작하면서 눈까리 붙였으면 끝났을 떄 떼야지 / 체크도 남발하지 마 제발 the final outcome should ALWAYS act
 * like a Slack thread".
 *
 *   node apps/chat/scripts/blind-reactions.mjs [--rooms channel,dm] [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *
 * In each room the owner posts a task that needs the work thread, then a question while the task runs, then "ok thanks" on the answer.
 * 1. The task and the question each get the agent's 👀 while it works on them, then one reply that answers that post (in a channel, in
 *    that post's thread), and at the end neither keeps the agent's 👀 or a ✅.
 * 2. "ok thanks" gets one reaction from the agent and no post.
 * 3. In the channel no agent post is a root post.
 * 4. No agent post has ✅ or 👀 in its text outside code, unless it names the reaction ("my 👀 reaction on p1"), ends on a sign-off emoji, or
 *    pastes a raw JSON or log line. On 11-21 a fresh agent, asked where a room's posts live, gave "a `set` line patches a post later, like my
 *    👀 reaction on p1" as its example, which uses no emoji as a status mark.
 * 👀 counts as seen when a poll saw it on the post or the agent's comm thread called set_emoji with eyes on it, since a fast answer can put
 * it on and take it off between two polls.
 *
 * Waits: the task waits up to 25 min for its result, since of 45 owner posts in channel threads by 11-20 the agent's first post came at
 * p90 1,082 s, the slow ones after a hand-over to the work thread. "ok thanks" waits 90 s after the agent's reaction for a post that should
 * not come, since the gaps between one turn's posts in #dev-search-general on 11-20 were 65 ms to 7 s.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { rooms: { type: "string" }, cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const kinds = (values.rooms ?? "channel,dm").split(",").map(k => k.trim()).filter(Boolean);
const TASK_MS = 25 * 60_000;
const QUESTION_MS = 15 * 60_000;
const THANKS_QUIET_MS = 90_000;
const THANKS_MS = 6 * 60_000;
const POLL_MS = 1_500;
const EYES = "👀";
/**
 * Whether a post uses ✅ or 👀 as a status mark outside code, as in "yes, all pass ✅". A post may name the reaction as a thing: "my 👀
 * reaction on p1", or after my, your, the or a, as in "my 👀 on p1 is a later `set` line", which two of four fresh agents wrote on 11-21
 * when asked where a room's posts live.
 */
const statusMark = text => [...text.replace(/```[\s\S]*?```|`[^`\n]*`/g, "").matchAll(/[✅👀]/gu)]
  .some(m => !/^\s*(?:reactions?|emoji|marks?)\b/u.test(m.input.slice(m.index + m[0].length)) && !/\b(?:my|your|his|the|a|an|its|their)\s+$/iu.test(m.input.slice(0, m.index)));
const CHECK = "✅";

/** The owner's kinds of posts from #sw-factory-build on 11-20: a task with a result to come, a question while it runs, and a thanks. */
const TASK = "can you run the apps/chat server tests for reactions and emoji and tell me if they pass?";
const QUESTION = "where does the chat server keep a room's posts?";
const THANKS = "ok thanks";

/** A post that ends on an emoji after its words, such as "yep, all 18 pass 🎉". */
const SIGN_OFF = /\p{Extended_Pictographic}\uFE0F?\s*$/u;
/** A code span or block that holds a JSON object or array with a key, such as `{"t":"set","post":"p1",...}`, or a timestamped log line. */
const RAW_LINE = /`{1,3}(?:json)?\s*[{[][^`]*"[^"`]+"\s*:|`{1,3}[^`]*\d{4}-\d\d-\d\dT\d\d:\d\d/;

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
const agent = await call("POST", "/api/agents", { name: `blind reactions ${stamp}`, test: true, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.host ? { host: values.host } : {}) });
console.log(`agent ${agent.id}`);

/** Every post of a room, roots and thread replies, oldest first. */
async function allPosts(room, kind) {
  const roots = (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
  if (kind !== "channel") return roots;
  const out = [...roots];
  for (const root of roots) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
const mine = (post, emoji) => (post?.reactions ?? []).some(r => r.emoji === emoji && r.by.some(b => b.id === agent.id));
const agentReactions = post => (post?.reactions ?? []).filter(r => r.by.some(b => b.id === agent.id)).map(r => r.emoji);

/** The set_emoji calls of the agent's comm thread for `room`, as `{message, emoji, on}`. */
async function emojiCalls(room) {
  const record = (await call("GET", "/api/agents?test=1")).find(a => a.id === agent.id);
  const thread = record?.comm?.find(c => c.room === room)?.thread;
  if (!thread) return [];
  const items = (await call("GET", `/api/c/${thread}/items?limit=200`)).items;
  const calls = [];
  for (const item of items) for (const step of item.steps ?? []) {
    if (step.kind !== "tool" || step.name !== "set_emoji") continue;
    try {
      const args = JSON.parse(step.summary);
      calls.push({ message: String(args.message_id ?? ""), emoji: String(args.emoji ?? ""), on: args.on !== false });
    } catch { /* a summary cut short names nothing */ }
  }
  return calls;
}
/**
 * Whether a set_emoji call names `post`: by its id, seq or room-qualified id, or by the [message id] pi-host stamped on its input, a base-36
 * time that falls after the post and before the next owner post (apps/chat/server/reactions.ts agentPost).
 */
function names(call, room, post, posts) {
  const id = call.message.trim().replace(new RegExp(`^${room}/`), "");
  if ([post.id, String(post.seq), `post ${post.seq}`].includes(id)) return true;
  if (!/^[0-9a-z]{6,10}$/.test(id)) return false;
  const at = parseInt(id, 36);
  const next = posts.find(p => p.author?.id !== agent.id && p.seq > post.seq);
  return post.at <= at && (!next || at < next.at);
}

async function runRoom(kind) {
  const room = kind === "dm" ? agent.room : (await call("POST", "/api/rooms", { kind: "channel", name: `blind-reactions-${stamp}`, agenda: "", members: [agent.id], test: true })).id;
  console.log(`\n${kind} ${room}`);
  const seen = new Map();
  const send = async (text, key, threadRoot) => (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-rx-${stamp}-${kind}-${key}`, ...(threadRoot ? { threadRoot } : {}) })).item;
  const poll = async () => {
    const posts = await allPosts(room, kind);
    for (const p of posts) if (mine(p, EYES)) seen.set(p.id, true);
    return posts;
  };
  const answersOf = (posts, id) => posts.filter(p => p.author?.id === agent.id && p.answers === id);
  const waitFor = async (ms, done) => {
    const until = Date.now() + ms;
    for (;;) {
      const posts = await poll();
      if (done(posts) || Date.now() > until) return posts;
      await sleep(POLL_MS);
    }
  };

  const started = Date.now();
  const task = await send(TASK, "task");
  await waitFor(90_000, posts => seen.has(task.id) || answersOf(posts, task.id).length > 0);
  const question = await send(QUESTION, "question");
  const questionAt = Date.now();
  await waitFor(QUESTION_MS, posts => answersOf(posts, question.id).length > 0);
  const questionSeconds = Math.round((Date.now() - questionAt) / 1000);
  await waitFor(TASK_MS - (Date.now() - started), posts => answersOf(posts, task.id).length > 0);
  const taskSeconds = Math.round((Date.now() - started) / 1000);
  // A last post of a turn can come a few seconds after its first, and 👀 comes off after the post.
  await sleep(30_000);
  let posts = await poll();
  const answer = answersOf(posts, question.id).at(-1);
  const thanks = await send(THANKS, "thanks", kind === "channel" && answer ? question.id : undefined);
  let reactedAt;
  posts = await waitFor(THANKS_MS, ps => {
    const p = ps.find(x => x.id === thanks.id);
    if (agentReactions(p).length && reactedAt === undefined) reactedAt = Date.now();
    return reactedAt !== undefined && Date.now() - reactedAt > THANKS_QUIET_MS;
  });
  // 👀 stays on the task until its checklist's last edit (pi-host 035ad3c8), which on 11-21 at 20:39Z came 10 min after the thanks, so the
  // end checks wait for the task's answers to hold no open item and for its 👀 to come off.
  posts = await waitFor(Math.max(0, TASK_MS - (Date.now() - started)), ps => !mine(ps.find(p => p.id === task.id), EYES)
    && answersOf(ps, task.id).every(p => !/^\s*[-*+] \[ \] /m.test(p.text)));

  const calls = await emojiCalls(room);
  const byId = id => posts.find(p => p.id === id);
  const eyesSeen = post => seen.has(post.id) || calls.some(c => c.on && emojiName(c.emoji) === "eyes" && names(c, room, post, posts));
  const replyChecks = (post, label) => {
    const replies = answersOf(posts, post.id);
    return [
      [`${label} got 👀 while the agent worked on it`, eyesSeen(post)],
      [`${label} got a reply that answers it`, replies.length > 0],
      ...(kind === "channel" ? [[`${label}'s reply is in its thread`, replies.length > 0 && replies.every(r => r.threadRoot === post.id)]] : []),
      [`${label} keeps no 👀 at the end`, !mine(byId(post.id), EYES)],
      [`${label} has no ✅`, !mine(byId(post.id), CHECK)],
    ];
  };
  const afterThanks = posts.filter(p => p.author?.id === agent.id && p.seq > thanks.seq);
  const checks = [
    ...replyChecks(question, "the question"),
    ...replyChecks(task, "the task"),
    ["ok thanks got one reaction", agentReactions(byId(thanks.id)).length === 1],
    ["ok thanks got no post", afterThanks.length === 0],
    ...(kind === "channel" ? [["no agent post is a root post", posts.every(p => p.author?.id !== agent.id || p.threadRoot)]] : []),
    ["no ✅ by the agent anywhere", posts.every(p => !mine(p, CHECK))],
    ["no ✅ or 👀 in the agent's post text", posts.every(p => p.author?.id !== agent.id || !statusMark(p.text))],
    ["no agent post ends with a sign-off emoji", posts.every(p => p.author?.id !== agent.id || !SIGN_OFF.test(p.text))],
    ["no agent post pastes a raw JSON or log line", posts.every(p => p.author?.id !== agent.id || !RAW_LINE.test(p.text))],
  ];
  const line = {
    room, kind, agent: agent.id, questionSeconds, taskSeconds,
    posts: posts.map(p => ({ id: p.id, author: p.author?.id === agent.id ? "agent" : "owner", threadRoot: p.threadRoot, answers: p.answers, reactions: (p.reactions ?? []).map(r => `${r.emoji} ${r.by.map(b => b.name).join(",")}`), text: p.text })),
    emojiCalls: calls, checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok),
  };
  for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}${p.answers ? ` answers ${p.answers}` : ""} [${p.reactions.join(" · ")}] ${p.text.slice(0, 140).replace(/\n/g, " ")}`);
  console.log(`${line.pass ? "PASS" : "FAIL"} ${kind}: ${checks.filter(([, ok]) => !ok).map(([n]) => `failed: ${n}`).join(", ") || "every check holds"}`);
  if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
  return line;
}

/** The Slack name an emoji argument means for the checks: eyes for 👀, :eyes: or eyes, else the argument. */
function emojiName(value) {
  const v = value.trim().replace(/^:|:$/g, "");
  return v === EYES ? "eyes" : v === CHECK ? "white_check_mark" : v;
}

const lines = await Promise.all(kinds.map(runRoom));
const summary = { agent: agent.id, rooms: lines.map(l => ({ room: l.room, kind: l.kind, pass: l.pass })), pass: lines.every(l => l.pass) };
if (values.out) appendFileSync(values.out, `${JSON.stringify(summary)}\n`);
console.log(`\n${summary.pass ? "PASS" : "FAIL"} ${lines.filter(l => l.pass).length}/${lines.length}`);
process.exit(summary.pass ? 0 : 1);

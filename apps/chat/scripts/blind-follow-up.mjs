#!/usr/bin/env node
/**
 * The blind follow-up check of the sw-factory skill (skills/sw-factory/SKILL.md, "Reactions and threads", rules 1, 7, 8 and 9): a fresh test
 * agent gets a multi-part research task in a fresh test channel, and once its thread reads done, a "how is it set up exactly" follow-up in
 * that thread, with no steering. The owner asked in #sw-factory-build p128 (msg mwqg8lug): "if i send a message like this, how does the
 * ACTUAL threads look like? ... for the OG message, and the follow-up message and how should it ideally look like", about his
 * #dev-app-search-prospect p14 and p16 (wiki:domains/devops/sw-factory-threads/message-flow-example.html).
 *
 *   node apps/chat/scripts/blind-follow-up.mjs [--set symphony|diary] [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *     [--threads-dir ~/.prime/agent/pi-host/durable/threads] [--keep]
 *
 * Checks, per run:
 * 1. The task and the follow-up each keep the agent's 👀 from the start until the work ends (the last version of the agent's reply or the
 *    done mark), when the first reply is a checklist with open items, and neither keeps 👀 at the end.
 * 2. The first reply to the task went out with no tell_owner call refused before it in the comm thread.
 * 3. The follow-up gets a reply within 60 s whose first version holds answer text above any `- [ ]` item.
 * 4. After the follow-up the work thread starts at most one job (a steer of a live job starts none).
 * 5. A job that writes a page starts after every other job of the task reported.
 * 6. No version of any agent post holds a table, ends on a sign-off emoji or pastes a raw JSON or log line.
 * Refused calls, steers and edit_message calls come from the threads' SQLite files on this box, since the items API drops a refused
 * tell_owner call and cuts tool summaries to one line; those fields are null when the agent runs on another host.
 *
 * The asks are about a repo of the asker's own (SETS), never sw factory, because on 11-20 fresh agents read sw-factory asks as feedback and
 * tagged @agent factory. The task waits up to 45 min for the done mark, since p14 took 27.6 min; the follow-up waits up to 30 min, since
 * p16 took 10.2 min with 3 jobs. The agent and room are archived at the end unless --keep.
 */
import { appendFileSync, existsSync, readlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const { values } = parseArgs({ options: { cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" }, "threads-dir": { type: "string" }, keep: { type: "boolean" }, set: { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const threadsDir = values["threads-dir"] ?? join(homedir(), ".prime/agent/pi-host/durable/threads");
const TASK_MS = 45 * 60_000;
const FOLLOW_MS = 30 * 60_000;
const FIRST_REPLY_S = 60;
const POLL_MS = 2_000;
const EYES = "👀";

/**
 * The owner's kinds of asks, after p14 ("research and assess and propose todo & issue") and p16 ("how is the data & flow set up exactly?"),
 * each about a repo of the asker's own. symphony is the default, an upstream clone we only read, because on 11-21 the diary ask led a fresh
 * agent to find a live auth hole on prod sieun.xyz and start a fix job that edited the real checkout.
 */
const SETS = {
  symphony: {
    cwd: join(homedir(), "code/symphony"),
    task: "we're thinking of running symphony for our team. can you research and assess how it picks up issues from linear, how it runs the agents in their workspaces, and how it tracks token use, and propose todos & issues for adopting it? one page with the findings would be good",
    followUp: "how is the issue data and the run flow set up exactly?",
  },
  diary: {
    cwd: join(homedir(), "Documents/Github/sieun-xyz"),
    task: "lets work on these for the diary site: how posts get saved and loaded from blob storage, the passkey login, and the embed blocks sandbox. can you research and assess each and propose todos & issues? one page with the findings would be good",
    followUp: "how is the post data and the save flow set up exactly?",
  },
};
const set = SETS[values.set ?? "symphony"];
if (!set) throw new Error(`--set is one of ${Object.keys(SETS).join(", ")}`);
const cwd = values.cwd ?? set.cwd;
const TASK = set.task;
const FOLLOW_UP = set.followUp;

const SIGN_OFF = /\p{Extended_Pictographic}\uFE0F?\s*$/u;
const RAW_LINE = /`{1,3}(?:json)?\s*[{[][^`]*"[^"`]+"\s*:|`{1,3}[^`]*\d{4}-\d\d-\d\dT\d\d:\d\d/;
const TABLE = /^[ \t]*\|?.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;
const TASK_ITEM = /^[ \t]*[-*+] \[[ xX]\] /;
const OPEN_ITEM = /^[ \t]*[-*+] \[ \] \S/m;
const MERMAID = /```mermaid/;
const WRITER_NAME = /\b(page|writer|write|wiki|doc)\b/i;
const WRITER_BRIEF = /\byou (?:are|take) the (?:page )?writer\b|Split:[^\n]*\byou write the page\b/i;
const HELD = "Kept as a note, not sent";
/** A text's words as tell_owner's long check counts them (reply-lint.ts `longReply`), with no list or task marker, as in blind-replies.mjs. */
const words = text => text.replace(/\]\([^)]*\)/g, "]").replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "").split(/\s+/).filter(Boolean).length;

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

const piHost = () => { try { return readlinkSync(join(homedir(), ".local/share/pi-host/current")); } catch { return null; } };
const piHostAtStart = piHost();
const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const agent = await call("POST", "/api/agents", { name: `blind follow ${stamp}`, test: true, cwd, ...(values.host ? { host: values.host } : {}) });
const room = (await call("POST", "/api/rooms", { kind: "channel", name: `blind-follow-${stamp}`, agenda: "", members: [agent.id], test: true })).id;
console.log(`agent ${agent.id} room ${room} cwd ${cwd}`);

const record = async () => (await call("GET", "/api/agents?test=1")).find(a => a.id === agent.id);
const roots = async () => (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
async function allPosts() {
  const top = await roots();
  const out = [...top];
  for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
const isAgent = post => post.author?.id === agent.id;
const mine = (post, emoji) => (post?.reactions ?? []).some(r => r.emoji === emoji && r.by.some(b => b.id === agent.id));

/** What the polls saw: each version of each post with the time it was first seen, the 👀 state per owner post, and each job's statuses. */
const versions = new Map();
const eyes = new Map();
const jobs = new Map();
let latest = [];
let workThread;

async function poll() {
  const now = Date.now();
  latest = await allPosts();
  for (const p of latest) {
    const seen = versions.get(p.id) ?? [];
    if (seen.at(-1)?.text !== p.text) seen.push({ at: seen.length ? now : Math.min(now, p.at ?? now), text: p.text });
    versions.set(p.id, seen);
    if (isAgent(p)) continue;
    const marks = eyes.get(p.id) ?? [];
    const on = mine(p, EYES);
    if (marks.at(-1)?.on !== on) marks.push({ at: now, on });
    eyes.set(p.id, marks);
  }
  workThread ??= (await record())?.thread;
  if (!workThread) return;
  for (const node of await call("GET", `/api/threads/${workThread}/jobs`)) {
    if (node.parent === null) continue;
    const job = jobs.get(node.id) ?? { id: node.id, name: node.name, parent: node.parent, depth: node.depth, createdAt: node.createdAt, firstSeen: now, statuses: [] };
    if (job.statuses.at(-1)?.status !== node.status) job.statuses.push({ at: now, status: node.status });
    job.name = node.name;
    jobs.set(node.id, job);
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

const send = async (text, key, threadRoot) => (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-follow-${stamp}-${key}`, ...(threadRoot ? { threadRoot } : {}) })).item;
const replyTo = id => latest.filter(p => isAgent(p) && p.answers === id);
/** The root's done mark, `{ by, at }`, or undefined while the thread is open. */
const doneMark = id => latest.find(p => p.id === id)?.done;
const rootDone = id => Boolean(doneMark(id));

/** The model entries of conversation 1 of a thread's SQLite file, read-only, or null when the file is not on this box. */
function entries(thread) {
  const file = join(threadsDir, `${thread}.sqlite`);
  if (!thread || !existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries WHERE conversation_id = 1 ORDER BY id").all().map(row => JSON.parse(row.record));
  } finally {
    db.close();
  }
}
const textOf = message => (typeof message.content === "string" ? message.content : (message.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

/** Every tool call in a thread's entries, with its time, arguments, and whether its result was an error or a held tell_owner. */
function toolCalls(list) {
  if (!list) return null;
  const results = new Map();
  for (const e of list) {
    const m = e.model?.[0];
    if (m?.role === "toolResult") results.set(m.toolCallId, { error: m.isError === true, text: textOf(m).slice(0, 300) });
  }
  const out = [];
  for (const e of list) {
    const m = e.model?.[0];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      const result = results.get(b.id);
      out.push({ at: (m.timestamp ?? 0) + (m.durationMs ?? 0), name: b.name, args: b.arguments ?? {}, error: result?.error ?? false, result: result?.text ?? "" });
    }
  }
  return out;
}

/**
 * Whether a set_emoji call names `post`: by its id, seq or room-qualified id, or by the [message id] pi-host stamped on its input, a base-36
 * time that falls after the post and before the next owner post (as in blind-reactions.mjs).
 */
function names(id, post, posts) {
  const clean = String(id).trim().replace(new RegExp(`^${room}/`), "");
  if ([post.id, String(post.seq), `post ${post.seq}`].includes(clean)) return true;
  if (!/^[0-9a-z]{6,10}$/.test(clean)) return false;
  const at = parseInt(clean, 36);
  const next = posts.find(p => !isAgent(p) && p.seq > post.seq);
  return post.at <= at && (!next || at < next.at);
}
const emojiName = v => { const s = String(v).trim().replace(/^:|:$/g, ""); return s === EYES ? "eyes" : s; };

/** The 👀 marks of a post: the polls' on and off, merged with the comm thread's set_emoji calls on it, oldest first. */
function eyeMarks(post, calls) {
  const fromCalls = (calls ?? []).filter(c => c.name === "set_emoji" && !c.error && emojiName(c.args.emoji) === "eyes" && names(c.args.message_id ?? "", post, latest))
    .map(c => ({ at: c.at, on: c.args.on !== false, by: "call" }));
  return [...(eyes.get(post.id) ?? []).map(m => ({ ...m, by: "poll" })), ...fromCalls].sort((a, b) => a.at - b.at);
}

/** The first version of the agent's reply split at its first task item: the words above it, a mermaid block, open items. */
function shape(text) {
  const lines = text.split("\n");
  const first = lines.findIndex(l => TASK_ITEM.test(l));
  const above = (first < 0 ? lines : lines.slice(0, first)).filter(l => !/^[ \t]*[-*+] /.test(l)).join(" ");
  const count = above.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(w => /\w/.test(w)).length;
  return { aboveWords: count, mermaid: MERMAID.test(text), checklist: first >= 0, openItems: OPEN_ITEM.test(text), answerFirst: count >= 15 || (first >= 0 && MERMAID.test(lines.slice(0, first).join("\n"))) };
}

/** 👀 checks for an owner post whose replies are `replies`: seen, kept until the work ended when the first reply was a checklist, off at the end. */
function eyeChecks(post, replies, calls, doneAt) {
  const marks = eyeMarks(post, calls);
  const firstOn = marks.find(m => m.on);
  const firstOff = firstOn ? marks.find(m => !m.on && m.at > firstOn.at) : undefined;
  const lastVersionAt = Math.max(0, ...replies.flatMap(r => (versions.get(r.id) ?? []).map(v => v.at)));
  const endAt = Math.max(lastVersionAt, doneAt ?? 0);
  const checklistFirst = replies.length > 0 && OPEN_ITEM.test(versions.get(replies[0].id)?.[0]?.text ?? replies[0].text);
  const offBeforeEnd = firstOff ? Math.round((endAt - firstOff.at) / 1000) : null;
  return {
    seen: Boolean(firstOn), checklistFirst, firstOnAt: firstOn?.at ?? null, firstOffAt: firstOff?.at ?? null, endAt, offSecondsBeforeEnd: offBeforeEnd,
    kept: Boolean(firstOn) && (!checklistFirst || !firstOff || firstOff.at >= endAt - 15_000),
    noneAtEnd: !mine(latest.find(p => p.id === post.id), EYES), marks,
  };
}

const started = Date.now();
let line;
try {
  const task = await send(TASK, "task");
  await waitFor(TASK_MS, () => rootDone(task.id));
  const taskDone = rootDone(task.id);
  const taskDoneAt = taskDone ? doneMark(task.id).at ?? Date.now() : null;
  // Keep polling through the wait, since the last edit can land seconds after the done mark and a gap in the polls dates it late.
  await waitFor(30_000, () => false);

  const followUp = await send(FOLLOW_UP, "follow-up", task.id);
  const followRepliesOf = () => (replyTo(followUp.id).length ? replyTo(followUp.id) : latest.filter(p => isAgent(p) && p.seq > followUp.seq).slice(0, 1));
  await waitFor(FOLLOW_MS, () => followRepliesOf().length > 0 && rootDone(task.id));
  const followDone = rootDone(task.id);
  const followDoneAt = followDone ? doneMark(task.id).at ?? Date.now() : null;
  // 👀 comes off after the post, and a job's report can land a little after the done mark.
  await waitFor(45_000, () => false);

  const rec = await record();
  const commThread = rec?.comm?.find(c => c.room === room)?.thread;
  const local = (rec?.host ?? hostname()) === hostname();
  const commCalls = local ? toolCalls(entries(commThread)) : null;
  const workCalls = local ? toolCalls(entries(workThread)) : null;

  const taskReplies = replyTo(task.id);
  const followReplies = followRepliesOf();
  const firstTaskReply = taskReplies[0];
  const firstFollow = followReplies[0];
  const firstFollowText = firstFollow ? versions.get(firstFollow.id)?.[0]?.text ?? firstFollow.text : "";
  const followSeconds = firstFollow ? Math.round(((versions.get(firstFollow.id)?.[0]?.at ?? firstFollow.at) - followUp.at) / 1000) : null;
  const followShape = shape(firstFollowText);

  const refused = (commCalls ?? []).filter(c => c.name === "tell_owner" && (c.error || c.result.startsWith(HELD)));
  const refusedBeforeFirst = firstTaskReply ? refused.filter(c => c.at < firstTaskReply.at) : refused;

  const workItems = workThread ? (await call("GET", `/api/c/${workThread}/items?limit=200`)).items : [];
  const reportAt = id => workItems.find(i => i.kind === "message" && i.author?.id === id && /^\[(agent-message from child|child-exited)/.test(i.text ?? ""))?.at ?? null;
  const jobList = [];
  for (const job of jobs.values()) {
    const first = (await call("GET", `/api/c/${job.id}/items?limit=3`).catch(() => ({ items: [] }))).items.find(i => i.kind === "message");
    const brief = (first?.text ?? "").slice(0, 600);
    const endAt = job.statuses.find((s, i) => i > 0 && s.status !== "working")?.at ?? null;
    jobList.push({ ...job, brief, reportAt: reportAt(job.id), endAt, writer: WRITER_NAME.test(job.name) || WRITER_BRIEF.test(brief) });
  }
  // Only the work thread's own jobs count; a job's subagent, such as one that writes that job's own page, is the job's business.
  const own = jobList.filter(j => j.parent === workThread);
  const taskJobs = own.filter(j => (j.createdAt ?? j.firstSeen) >= task.at && (j.createdAt ?? j.firstSeen) < followUp.at);
  const followJobs = own.filter(j => (j.createdAt ?? j.firstSeen) >= followUp.at);
  const writerOrder = taskJobs.filter(j => j.writer).map(w => {
    const others = taskJobs.filter(j => !j.writer);
    const lastReport = Math.max(0, ...others.map(j => j.reportAt ?? j.endAt ?? Infinity));
    return { writer: w.name, createdAt: w.createdAt, lastOtherReport: Number.isFinite(lastReport) ? lastReport : null, after: w.createdAt >= lastReport };
  });
  const steers = (workCalls ?? []).filter(c => c.at >= followUp.at && c.name === "ipython" && /receiver_role\s*=\s*["']child["']/.test(String(c.args.code ?? "")))
    .map(c => ({ at: c.at, code: String(c.args.code).slice(0, 400) }));
  const edits = [...(commCalls ?? []).map(c => ({ ...c, thread: "comm" })), ...(workCalls ?? []).map(c => ({ ...c, thread: "work" }))]
    .filter(c => c.name === "edit_message").map(c => ({ thread: c.thread, at: c.at, message: c.args.message_id, error: c.error, text: String(c.args.text ?? "") }));

  const taskPost = latest.find(p => p.id === task.id);
  const followPost = latest.find(p => p.id === followUp.id);
  const taskEyes = eyeChecks(taskPost, taskReplies, commCalls, taskDoneAt);
  const followEyes = eyeChecks(followPost, followReplies, commCalls, followDoneAt);
  const agentVersions = latest.filter(isAgent).flatMap(p => (versions.get(p.id) ?? [{ text: p.text }]).map(v => v.text));

  const checks = [
    ["the task thread read done", taskDone],
    ["the task got 👀", taskEyes.seen],
    ["the task kept 👀 until its work ended", taskEyes.kept],
    ["the task keeps no 👀 at the end", taskEyes.noneAtEnd],
    ["the first reply to the task went out with no refused tell_owner before it", commCalls === null ? null : refusedBeforeFirst.length === 0],
    [`the follow-up got a reply within ${FIRST_REPLY_S} s`, followSeconds !== null && followSeconds <= FIRST_REPLY_S],
    ["the follow-up's first reply holds answer text above any checklist", followShape.answerFirst],
    ["the follow-up got 👀", followEyes.seen],
    ["the follow-up kept 👀 until its work ended", followEyes.kept],
    ["the follow-up keeps no 👀 at the end", followEyes.noneAtEnd],
    ["the thread read done again after the follow-up", followDone],
    ["the follow-up started at most one job", followJobs.length <= 1],
    ["a page writer started after the other jobs reported", writerOrder.every(w => w.after)],
    ["no agent post holds a table", agentVersions.every(t => !TABLE.test(t))],
    ["no agent post ends on a sign-off emoji", agentVersions.every(t => !SIGN_OFF.test(t))],
    ["no agent post pastes a raw JSON or log line", agentVersions.every(t => !RAW_LINE.test(t))],
  ];
  line = {
    at: new Date().toISOString(), set: values.set ?? "symphony", piHost: { start: piHostAtStart, end: piHost() }, agent: agent.id, room, cwd, workThread, commThread, seconds: Math.round((Date.now() - started) / 1000),
    thread: `${server}/#/c/${room}?thread=${task.id}`,
    task: { id: task.id, at: task.at, doneAt: taskDoneAt, firstReplyAt: firstTaskReply?.at ?? null, firstReplySeconds: firstTaskReply ? Math.round((firstTaskReply.at - task.at) / 1000) : null, eyes: taskEyes },
    followUp: { id: followUp.id, at: followUp.at, doneAt: followDoneAt, firstReplySeconds: followSeconds, firstReply: firstFollowText, shape: followShape, eyes: followEyes },
    refusals: refused.map(c => ({ at: c.at, text: String(c.args.text ?? "").slice(0, 300), result: c.result })), refusedBeforeFirstReply: commCalls === null ? null : refusedBeforeFirst.length,
    jobs: jobList.map(({ statuses, ...j }) => ({ ...j, statuses })), taskJobs: taskJobs.map(j => j.name), followJobs: followJobs.map(j => j.name), writerOrder, steers, edits,
    posts: latest.map(p => ({ id: p.id, author: isAgent(p) ? "agent" : "owner", threadRoot: p.threadRoot, answers: p.answers, done: p.done?.at ?? null, reactions: (p.reactions ?? []).map(r => `${r.emoji} ${r.by.map(b => b.name).join(",")}`), versions: (versions.get(p.id) ?? []).map(v => ({ ...v, words: words(v.text) })) })),
    checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok !== false),
  };
  for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}${p.answers ? ` answers ${p.answers}` : ""} [${p.reactions.join(" · ")}]${p.done ? " [done]" : ""} ${p.versions.length} versions (${p.versions.map(v => v.words).join(", ")} words): ${(p.versions.at(-1)?.text ?? "").slice(0, 160).replace(/\n/g, " ")}`);
  console.log(`jobs: ${line.jobs.map(j => `${j.name} (${new Date(j.createdAt ?? j.firstSeen).toISOString().slice(11, 19)}${j.reportAt ? ` to ${new Date(j.reportAt).toISOString().slice(11, 19)}` : ""})`).join(", ")}`);
  console.log(`follow-up first reply after ${followSeconds} s:\n${firstFollowText}`);
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

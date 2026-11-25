#!/usr/bin/env node
/**
 * The blind check for a work thread's result that names an older thread: a fresh test agent joins a fresh test channel after the owner's
 * ask there reached another agent, answers a newer root post, and then gets its work thread's report for the older thread. The result must
 * land in the older thread. On 11-24 Crawler guy's comm thread posted the media result for the owner's p65 (thread p42 of
 * #dev-app-search-prospect) with reply_to mwto4rot, the id Search product's thread got for p65 before Crawler guy joined, and both posts
 * (p80, p86) went in the thread of the newer p76.
 *
 *   node apps/chat/scripts/blind-reply-target.mjs [--out <file.jsonl>] [--server http://127.0.0.1:5184] [--keep]
 *
 * Both test agents work in a made-up project, lantern, that the run writes to a temp folder: a README, an Apache LICENSE and a CI log
 * with each job's time, so the topic and the question are answered from local files. On 11-25 the topic was symphony's CI, and helpers
 * of runs side by side paged `gh api repos/openai/symphony/actions/runs` and each run's jobs until us-metal02's shared GitHub token had
 * 120 of 5,000 calls left (devbox-github-quota-low), after which every gh call on the box answers 403 until the reset.
 *
 * 1. A helper test agent is the channel's only member when the owner posts a root topic and the ask as a reply in its thread, as p42 and
 *    p65 were, so the ask's message id is the helper thread's stamp.
 * 2. The test agent is made with a brief that names the ask by post id, message id and thread, as Crawler guy's memory named "p65
 *    (mwto4rot)", and joins.
 * 3. The owner posts a newer, unrelated root question, and the test agent answers it.
 * 4. The run submits the work thread's report to the test agent's comm thread through pi-host's socket, as `agent_message.send` from the
 *    work thread does: "Result for thread pN of #room: ...", with no steering on where to post.
 * The check: the agent's post that carries the result sits in the topic's thread, and every agent's answer to the question, the helper's
 * too, sits in the question's thread. The line also records the post's reply_to, read from the
 * comm thread's entries, so a run that named the ask by post id and a run that used the other thread's message id show apart.
 */
import { appendFileSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" }, server: { type: "string" }, keep: { type: "boolean" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const chatDb = join(homedir(), ".pi/agent/chat/chat.sqlite");
const socketPath = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, "pi-host/host.sock");
const ANSWER_MS = 20 * 60_000;
const QUIET_MS = 60_000;
const POLL_MS = 2_000;

const TOPIC = "let's cut what lantern's CI costs us. first we need to know where the time goes.";
const ASK = "we need someone to measure how long lantern's test suite takes to run. i'll set up a separate agent for that.";
const QUESTION = "unrelated quick one, what license is lantern under?";
const REPORT = (root, room) => `Result for thread ${root} of #${room}: lantern's test suite took 41 s, 39 s and 40 s over three runs.\n` +
  "- 214 tests ran, with 0 failures and 2 skipped.\n- The slowest file was tests/test_scheduler.py at 11 s.";
/** The project folder both agents work in. Its numbers stay clear of 41 and 214, which mark the report's result. */
const FIXTURE = {
  "README.md": "# lantern\n\nA small job queue in Python. CI runs lint, typecheck and the pytest suite on every push.\n" +
    "The last CI run's job times are in logs/ci-run.log.\n",
  "LICENSE": "                                 Apache License\n                           Version 2.0, January 2004\n" +
    "                        http://www.apache.org/licenses/\n\n   Copyright 2026 The lantern authors\n\n" +
    "   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n",
  "logs/ci-run.log": "ci run 1123 on push to main, 2026-11-23 09:12 UTC\n" +
    "job lint        started 09:12:05  finished 09:13:17  1m12s\n" +
    "job typecheck   started 09:12:05  finished 09:14:10  2m05s\n" +
    "job test        started 09:12:05  finished 09:18:35  6m30s  (setup 2m50s, pip install 1m55s, pytest 1m45s)\n" +
    "job build-image started 09:18:36  finished 09:22:08  3m32s\n" +
    "total 10m03s, billed 13m19s\n",
};

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

/** One pi-host command over its socket, as apps/chat's host client sends it. */
function piHost(type, fields) {
  return new Promise((resolve, reject) => {
    const id = `blind-reply-target-${Date.now()}`;
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...fields, type, id })}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const line = text.trim() ? JSON.parse(text) : {};
        if (line.type !== "response" || line.id !== id) continue;
        socket.end();
        if (line.success) resolve(line.data ?? {});
        else reject(new Error(`${type}: ${line.error}`));
      }
    });
  });
}

/** A post's row and an agent's record as apps/chat stores them, read-only, for the fields the API leaves out (`inputs`, `comm`). */
function stored(sql, ...args) {
  const db = new DatabaseSync(chatDb, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...args);
    return row ? JSON.parse(row.body) : undefined;
  } finally {
    db.close();
  }
}

/** The reply_to of each tell_owner or send_message call in a comm thread, read-only from its thread file. */
function replyTos(thread) {
  const db = new DatabaseSync(join(homedir(), ".prime/agent/pi-host/durable/threads", `${thread}.sqlite`), { readOnly: true });
  try {
    return db.prepare("select record from entries where conversation_id = 1 order by id").all().flatMap(({ record }) => {
      const content = JSON.parse(record).model?.[0]?.content;
      return Array.isArray(content) ? content.filter(b => b.type === "toolCall" && ["tell_owner", "send_message"].includes(b.name))
        .map(b => ({ tool: b.name, reply_to: b.arguments?.reply_to ?? null, text: String(b.arguments?.text ?? "").slice(0, 120) })) : [];
    });
  } finally {
    db.close();
  }
}

const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const fixtureRoot = join(tmpdir(), `blind-reply-target-${stamp}`);
const cwd = join(fixtureRoot, "lantern");
for (const [file, text] of Object.entries(FIXTURE)) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
}
const roomName = `blind-reply-target-${stamp}`;
const helper = await call("POST", "/api/agents", { name: `blind rt helper ${stamp}`, test: true, cwd });
const room = (await call("POST", "/api/rooms", { kind: "channel", name: roomName, agenda: "", members: [helper.id], test: true })).id;
let agent;
console.log(`helper ${helper.id} room ${room}`);

const send = async (text, key, threadRoot) =>
  (await call("POST", `/api/c/${room}/send`, { text, requestId: `blind-reply-target-${stamp}-${key}`, ...(threadRoot ? { threadRoot } : {}) })).item;
async function allPosts() {
  const top = (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
  const out = [...top];
  for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
  return out.sort((a, b) => a.seq - b.seq);
}
async function waitFor(ms, done) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value || Date.now() > until) return value;
    await sleep(POLL_MS);
  }
}
const piHostRelease = () => { try { return readlinkSync(join(homedir(), ".local/share/pi-host/current")); } catch { return null; } };
const chatRelease = () => { try { return readlinkSync(join(homedir(), ".local/share/sieun-pi-apps-chat/current")); } catch { return null; } };

const started = Date.now();
let line;
try {
  const topic = await send(TOPIC, "topic");
  const ask = await send(ASK, "ask", topic.id);
  const helperThread = await waitFor(5 * 60_000, () => stored("select body from agents_agents where id = ?", helper.id)?.comm?.[room]);
  const askStamp = await waitFor(5 * 60_000, () => stored("select body from posts where room = ? and id = ?", room, ask.id)?.inputs?.find(i => i.thread === helperThread)?.at);
  if (!askStamp) throw new Error(`the ask ${ask.id} never entered the helper's comm thread`);
  const askId = askStamp.toString(36);

  agent = await call("POST", "/api/agents", {
    name: `blind rt ${stamp}`, test: true, cwd,
    brief: `# blind rt ${stamp}\n\nYou measure things in the lantern project (${cwd}) for the owner.\n\n` +
      `Owner ask: #${roomName} ${ask.id} (message id ${askId}), in thread ${topic.id}: "${ASK}" Your work thread is measuring it.\n`,
  });
  await call("POST", `/api/rooms/${room}/members`, { agents: [agent.id] });
  const question = await send(QUESTION, "question");
  const isAgent = p => p.author?.id === agent.id;
  await waitFor(ANSWER_MS, async () => (await allPosts()).some(p => isAgent(p) && p.threadRoot === question.id));
  // The answer's turn may still close with a reaction or an edit.
  await sleep(QUIET_MS);

  const record = stored("select body from agents_agents where id = ?", agent.id);
  const comm = record?.comm?.[room];
  if (!comm) throw new Error(`no comm thread for ${agent.id} in ${room}`);
  const before = new Set((await allPosts()).filter(isAgent).map(p => p.id));
  await piHost("durable_submit", {
    thread: comm, text: `[agent-message from sibling:blind rt ${stamp}]\n\n${REPORT(topic.id, roomName)}`,
    requestId: `blind-reply-target:${stamp}`, whenBusy: "followUp", entry: { kind: "agent.message", data: { from: record.workThread, via: "agent_message" } },
  });
  const reported = Date.now();
  const result = await waitFor(ANSWER_MS, async () => (await allPosts()).find(p => isAgent(p) && !before.has(p.id) && /\b41\b|\b214\b/.test(p.text)));
  await sleep(QUIET_MS / 2);
  const posts = await allPosts();
  const calls = replyTos(comm);
  const checks = [
    ["the quick question got an answer in its own thread", posts.some(p => isAgent(p) && p.threadRoot === question.id)],
    ["the result came", Boolean(result)],
    ["the result sits in the ask's thread", result?.threadRoot === topic.id],
    ["no result sits in the question's thread", !posts.some(p => isAgent(p) && p.threadRoot === question.id && /\b41\b|\b214\b/.test(p.text))],
    // The helper gets the question mid-turn, and on 11-25 it answered it in one round with its reply_to answer to the topic and a mark of
    // the ask, which put the license answer in the topic's thread (blind-old2, blind-new2).
    ["every license answer, the helper's too, sits in the question's thread", posts.filter(p => p.author?.id !== "owner" && /apache/i.test(p.text)).every(p => p.threadRoot === question.id)],
  ];
  line = {
    at: new Date().toISOString(), piHost: piHostRelease(), chat: chatRelease(), helper: helper.id, agent: agent.id, room, comm, seconds: Math.round((Date.now() - started) / 1000),
    resultSeconds: result ? Math.round(((result.at ?? Date.now()) - reported) / 1000) : null, topic: topic.id, ask: ask.id, askId, question: question.id,
    result: result ? { id: result.id, threadRoot: result.threadRoot ?? null, answers: result.answers ?? null, text: result.text } : null, calls,
    posts: posts.map(p => ({ id: p.id, author: p.author?.id ?? null, threadRoot: p.threadRoot ?? null, text: String(p.text).slice(0, 160) })),
    checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok),
  };
  for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}: ${p.text.replace(/\n/g, " / ")}`);
  for (const c of calls) console.log(`  call ${c.tool} reply_to=${c.reply_to}: ${c.text.replace(/\n/g, " / ")}`);
  for (const [name, ok] of checks) console.log(`${ok ? "pass" : "FAIL"} ${name}`);
  console.log(line.pass ? "PASS" : "FAIL");
} catch (error) {
  line = { at: new Date().toISOString(), helper: helper.id, agent: agent?.id ?? null, room, error: String(error?.stack ?? error), pass: false };
  console.error(error);
} finally {
  if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
  if (!values.keep) {
    const agents = await call("GET", "/api/agents?test=1").catch(() => []);
    for (const id of [helper.id, agent?.id].filter(Boolean)) {
      const thread = agents.find(a => a.id === id)?.thread;
      if (thread) await call("PATCH", `/api/c/${thread}`, { archived: true }).catch(e => console.error(`archive agent: ${e}`));
    }
    await call("PATCH", `/api/rooms/${room}`, { archived: true }).catch(e => console.error(`archive room: ${e}`));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
process.exit(line?.pass ? 0 : 1);

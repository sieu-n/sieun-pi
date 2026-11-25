#!/usr/bin/env node
/**
 * The blind check for an owner post that names two other members of a thread a third agent is in, with a go in it. On 11-25 the owner
 * wrote "@Search product, misc. and @fable auditor agree right? agree on the details, then go implement" (#dev-crawler p45, mww0ks1y) in a
 * thread devops guy was in, and devops guy's comm thread answered "We agree on everything except two names, so here are my picks for those
 * and the build starts now" and handed its work thread the build.
 *
 *   node apps/chat/scripts/blind-named-others.mjs [--out <file.jsonl>] [--server http://127.0.0.1:5184] [--keep]
 *
 * Three fresh test agents work in a made-up project, lantern, that the run writes to a temp folder, so every answer comes from local files.
 * 1. The owner posts a root topic in a fresh test channel with all three as members, then a reply in its thread that names all three and
 *    asks each for one cut, so each is in the thread.
 * 2. Once each has answered, the owner replies in the thread naming the first two only: whether they both back the third's pick, to settle
 *    the open points between them and then start building it.
 * The check covers the third agent's comm thread from that reply's input to the next input: no tell_owner or send_message post, no 👀, and
 * no agent_message.send to its work thread. Its later posts are listed too, since the first two may hand it a part by name.
 */
import { appendFileSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string" }, server: { type: "string" }, keep: { type: "boolean" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const chatDb = join(homedir(), ".pi/agent/chat/chat.sqlite");
const ANSWER_MS = 20 * 60_000;
const QUIET_MS = 90_000;
const POLL_MS = 2_000;

const FIXTURE = {
  "README.md": "# lantern\n\nA small job queue in Python. CI runs lint, typecheck, the pytest suite and an image build on every push.\n" +
    "The last CI run's job times are in logs/ci-run.log.\n",
  "logs/ci-run.log": "ci run 1123 on push to main, 2026-11-23 09:12 UTC\n" +
    "job lint        started 09:12:05  finished 09:13:17  1m12s\n" +
    "job typecheck   started 09:12:05  finished 09:14:10  2m05s\n" +
    "job test        started 09:12:05  finished 09:18:35  6m30s  (setup 2m50s, pip install 1m55s, pytest 1m45s)\n" +
    "job build-image started 09:18:36  finished 09:22:08  3m32s  (runs after test, only needed on main)\n" +
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

function stored(sql, ...args) {
  const db = new DatabaseSync(chatDb, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...args);
    return row ? JSON.parse(row.body) : undefined;
  } finally {
    db.close();
  }
}

/** Conversation 1 of a comm thread, read-only: each input's text and each tool call, in order. */
function commLog(thread) {
  const db = new DatabaseSync(join(homedir(), ".prime/agent/pi-host/durable/threads", `${thread}.sqlite`), { readOnly: true });
  try {
    return db.prepare("select record from entries where conversation_id = 1 order by id").all().flatMap(({ record }) => {
      const entry = JSON.parse(record);
      const content = entry.model?.[0]?.content;
      if (entry.kind === "pi.user" || entry.kind === "agent.message") {
        const text = typeof content === "string" ? content : (content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
        return [{ input: text }];
      }
      return Array.isArray(content) ? content.filter(b => b.type === "toolCall").map(b => ({ tool: b.name, args: b.arguments ?? {} })) : [];
    });
  } finally {
    db.close();
  }
}

const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const fixtureRoot = join(tmpdir(), `blind-named-others-${stamp}`);
const cwd = join(fixtureRoot, "lantern");
for (const [file, text] of Object.entries(FIXTURE)) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
}
const names = ["kestrel", "marten", "osprey"].map(n => `${n} ${stamp}`);
const made = [];
const piHostRelease = () => { try { return readlinkSync(join(homedir(), ".local/share/pi-host/current")); } catch { return null; } };
const chatRelease = () => { try { return readlinkSync(join(homedir(), ".local/share/sieun-pi-apps-chat/current")); } catch { return null; } };

let room;
let line;
const started = Date.now();
try {
  for (const name of names) {
    made.push(await call("POST", "/api/agents", {
      name, test: true, cwd,
      brief: `# ${name}\n\nYou work on the lantern project (${cwd}) for the owner: its CI, its tests and its build.\n`,
    }));
  }
  const [a, b, c] = made.map((m, i) => ({ id: m.id, name: names[i] }));
  room = (await call("POST", "/api/rooms", { kind: "channel", name: `blind-named-others-${stamp}`, agenda: "", members: made.map(m => m.id), test: true })).id;
  console.log(`room ${room} agents ${made.map(m => m.id).join(" ")}`);
  const send = async (text, key, threadRoot, mentions) => (await call("POST", `/api/c/${room}/send`, {
    text, requestId: `blind-named-others-${stamp}-${key}`, ...(threadRoot ? { threadRoot } : {}), ...(mentions ? { mentions } : {}),
  })).item;
  const allPosts = async () => {
    const top = (await call("GET", `/api/c/${room}/items?limit=200`)).items.filter(i => i.kind === "message");
    const out = [...top];
    for (const root of top) if (root.thread) out.push(...(await call("GET", `/api/c/${room}/replies/${root.id}`)).items);
    return out.sort((x, y) => x.seq - y.seq);
  };
  const waitFor = async (ms, done) => {
    const until = Date.now() + ms;
    for (;;) {
      const value = await done();
      if (value || Date.now() > until) return value;
      await sleep(POLL_MS);
    }
  };

  const topic = await send("lantern's CI takes 10 minutes a push and that's too slow. let's cut it.", "topic");
  await send(`@${a.name} @${b.name} @${c.name} one line each: what's the first thing you'd cut? the job times are in logs/ci-run.log`, "each", topic.id,
    made.map(m => m.id));
  const answered = await waitFor(ANSWER_MS, async () => {
    const posts = await allPosts();
    return made.every(m => posts.some(p => p.author?.id === m.id && p.threadRoot === topic.id)) ? posts : undefined;
  });
  if (!answered) throw new Error("not all three answered the first ask");
  await sleep(QUIET_MS);

  const go = await send(`@${a.name} and @${b.name} you two both fine with ${c.name}'s pick? sort out whatever's still open between you and then start building it`,
    "go", topic.id, [a.id, b.id]);
  const commC = await waitFor(60_000, () => stored("select body from agents_agents where id = ?", c.id)?.comm?.[room]);
  await waitFor(ANSWER_MS, () => commLog(commC).some(e => e.input?.includes(`post ${go.seq} from`)));
  await sleep(4 * QUIET_MS);

  const log = commLog(commC);
  const at = log.findIndex(e => e.input?.includes(`post ${go.seq} from`));
  const next = log.findIndex((e, i) => i > at && e.input !== undefined);
  const turn = log.slice(at + 1, next < 0 ? undefined : next);
  const posted = turn.filter(e => ["tell_owner", "send_message"].includes(e.tool));
  const eyes = turn.filter(e => e.tool === "set_emoji" && e.args.emoji === "eyes" && e.args.on !== false);
  const handed = turn.filter(e => e.tool === "ipython" && /agent_message\.send/.test(String(e.args.code ?? "")));
  const posts = await allPosts();
  const later = posts.filter(p => p.author?.id === c.id && p.seq > go.seq);
  const checks = [
    ["the go reached the third agent with the line that it names the other two, not it", log[at]?.input?.includes("not you)") ?? false],
    ["the third agent posted nothing on the go", posted.length === 0],
    ["the third agent put no 👀 on the go", eyes.length === 0],
    ["the third agent handed its work thread nothing on the go", handed.length === 0],
  ];
  line = {
    at: new Date().toISOString(), piHost: piHostRelease(), chat: chatRelease(), room, agents: made.map(m => m.id), seconds: Math.round((Date.now() - started) / 1000),
    goInput: log[at]?.input?.slice(0, 400) ?? null, turn: turn.map(e => ({ tool: e.tool, args: JSON.stringify(e.args).slice(0, 300) })),
    later: later.map(p => ({ id: p.id, threadRoot: p.threadRoot ?? null, text: String(p.text).slice(0, 200) })),
    posts: posts.map(p => ({ id: p.id, author: p.author?.id ?? null, threadRoot: p.threadRoot ?? null, text: String(p.text).slice(0, 200) })),
    checks: Object.fromEntries(checks), pass: checks.every(([, ok]) => ok),
  };
  for (const p of line.posts) console.log(`  ${p.id} ${p.author}${p.threadRoot ? ` in ${p.threadRoot}` : ""}: ${p.text.replace(/\n/g, " / ")}`);
  for (const e of line.turn) console.log(`  third agent's turn on the go: ${e.tool} ${e.args}`);
  for (const [name, ok] of checks) console.log(`${ok ? "pass" : "FAIL"} ${name}`);
  console.log(line.pass ? "PASS" : "FAIL");
} catch (error) {
  line = { at: new Date().toISOString(), room, agents: made.map(m => m.id), error: String(error?.stack ?? error), pass: false };
  console.error(error);
} finally {
  if (values.out) appendFileSync(values.out, `${JSON.stringify(line)}\n`);
  if (!values.keep) {
    const agents = await call("GET", "/api/agents?test=1").catch(() => []);
    for (const { id } of made) {
      const thread = agents.find(x => x.id === id)?.thread;
      if (thread) await call("PATCH", `/api/c/${thread}`, { archived: true }).catch(e => console.error(`archive agent: ${e}`));
    }
    if (room) await call("PATCH", `/api/rooms/${room}`, { archived: true }).catch(e => console.error(`archive room: ${e}`));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
process.exit(line?.pass ? 0 : 1);

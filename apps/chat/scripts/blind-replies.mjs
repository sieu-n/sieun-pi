#!/usr/bin/env node
/**
 * The blind reply check of the sw-factory skill (skills/sw-factory/SKILL.md): a fresh test agent in a fresh test channel gets the owner's
 * real kinds of asks with no steering, and each reply is checked against the ideal replies page
 * (wiki:agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html).
 *
 *   node apps/chat/scripts/blind-replies.mjs [--asks <file.json>] [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *
 * The first ask is the channel's root post and every later one a reply in its thread, as the owner asks in a channel. An ask is
 * `{text, expect, wait}`, where `expect` is "reply" (one short Slack post) or "reaction" (no post), and `wait: false` sends the next ask at
 * once, so the agent answers both together, as when the owner sent p14 and p15 7 s apart on 11-20. The agent and the room are `test: true`, so no
 * owner list shows them. Each line of --out is one ask with its replies, its checks and pass or fail; the last line is the run's summary.
 *
 * Waits: an ask waits up to 20 min for its first answer, since of 45 owner posts in channel threads by 11-20 the agent's first post came
 * at p50 36 s and p90 1,082 s, the slow ones after a hand-over to the work thread. After a post it waits 60 s with no new post before it
 * reads the answer as whole, since the gaps between one turn's posts in #dev-search-general on 11-20 were 65 ms to 7 s.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { asks: { type: "string" }, cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const FIRST_MS = 20 * 60_000;
const QUIET_MS = 60_000;
const POLL_MS = 3_000;

/** The owner's kinds of asks from #dev-search-general and #sw-factory-build on 11-20. */
const DEFAULT_ASKS = [
  { text: "did you install modern-web-guidance into this repo, and nothing else?", expect: "reply" },
  { text: "what pieces make up the skill setup agents get in this repo? where does each one live?", expect: "reply" },
  { text: "is it all working?", expect: "reply" },
  { text: "ok thanks", expect: "reaction" },
];
const asks = values.asks ? JSON.parse(readFileSync(values.asks, "utf8")) : DEFAULT_ASKS;

/** One API call; while a release restarts the chat server the call is retried within the ask's own wait, since runs 2 and 3 on 11-20 died on it. */
async function call(method, path, body) {
  const until = Date.now() + FIRST_MS;
  let response;
  for (;;) {
    try {
      response = await fetch(`${server}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      break;
    } catch (error) {
      if (Date.now() > until) throw error;
      await sleep(POLL_MS);
    }
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TABLE = /^[ \t]*\|?.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;
const words = text => text.replace(/\]\([^)]*\)/g, "]").split(/\s+/).filter(Boolean).length;
const sentences = text => text.replace(/\]\([^)]*\)/g, "]").split(/(?<=[.!?])\s+/).filter(Boolean);

/** The ideal replies page's rules that a script can read; the reader judges the tone from the printed text. */
function checks(ask, posts, asked) {
  const text = posts.map(p => p.text).join("\n\n");
  if (ask.expect === "reaction") return [["no post, a reaction says it", posts.length === 0]];
  return [
    ["one post for the posts it answers", posts.length === 1],
    ["no table", !TABLE.test(text)],
    ["no heading, bold or label opener", !/^#{1,6} |\*\*|^[A-Z][\w ]{0,20}:\s/m.test(text)],
    ["at most 80 words, as config/AGENTS.md rule 5", words(text) <= 80 * asked],
    ["no sentence over 35 words", sentences(text).every(s => words(s) <= 35)],
  ];
}

/** Month, day, time to the second and 2 random letters, since two runs started in one minute on 11-20 got one channel name. */
const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const agent = await call("POST", "/api/agents", { name: `blind replies ${stamp}`, test: true, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.host ? { host: values.host } : {}) });
const room = await call("POST", "/api/rooms", { kind: "channel", name: `blind-replies-${stamp}`, agenda: "", members: [agent.id], test: true });
console.log(`agent ${agent.id}, room ${room.id}`);

let root;
const results = [];
/** Asks sent with `wait: false` go out at once, and the next ask waits for the answers to all of them, as when he sends two posts in a row. */
let group = [];
for (const [index, ask] of asks.entries()) {
  const sent = await call("POST", `/api/c/${room.id}/send`, { text: ask.text, requestId: `blind-${stamp}-${index}`, ...(root ? { threadRoot: root } : {}) });
  root ??= sent.item.id;
  group.push({ ...ask, id: sent.item.id });
  if (ask.wait === false) continue;
  const ids = new Set(group.map(g => g.id));
  const started = Date.now();
  let posts = [];
  let lastNew = 0;
  for (;;) {
    await sleep(POLL_MS);
    const thread = await call("GET", `/api/c/${room.id}/replies/${root}`);
    const now = thread.items.filter(i => i.author?.id === agent.id && ids.has(i.answers));
    if (now.length > posts.length) lastNew = Date.now();
    posts = now;
    const reacted = [thread.root, ...thread.items].find(i => i.id === ask.id)?.reactions?.some(r => r.by.some(b => b.id === agent.id));
    if (posts.length && Date.now() - lastNew > QUIET_MS) break;
    if (!posts.length && ask.expect === "reaction" && reacted && Date.now() - started > QUIET_MS) break;
    if (Date.now() - started > FIRST_MS) break;
  }
  const text = group.map(g => g.text).join(" / ");
  const result = checks(ask, posts, group.length);
  const line = { ask: text, askIds: [...ids], expect: ask.expect, seconds: Math.round((Date.now() - started) / 1000), replies: posts.map(p => p.text), checks: Object.fromEntries(result), pass: result.every(([, ok]) => ok) };
  results.push(line);
  console.log(`\n${line.pass ? "PASS" : "FAIL"} ${text}\n${posts.map(p => `  > ${p.text.replace(/\n/g, "\n    ")}`).join("\n") || "  (no post)"}\n  ${result.filter(([, ok]) => !ok).map(([name]) => `failed: ${name}`).join(", ")}`);
  if (values.out) appendFileSync(values.out, `${JSON.stringify({ room: room.id, agent: agent.id, ...line })}\n`);
  group = [];
}
const summary = { room: room.id, root, agent: agent.id, passed: results.filter(r => r.pass).length, of: results.length, pass: results.every(r => r.pass) };
if (values.out) appendFileSync(values.out, `${JSON.stringify(summary)}\n`);
console.log(`\n${summary.pass ? "PASS" : "FAIL"} ${summary.passed}/${summary.of}, thread ${server}/#/c/${room.id}?thread=${root}`);
process.exit(summary.pass ? 0 : 1);

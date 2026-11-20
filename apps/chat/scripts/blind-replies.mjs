#!/usr/bin/env node
/**
 * The blind reply check of the sw-factory skill (skills/sw-factory/SKILL.md): a fresh test agent in a fresh test channel gets the owner's
 * real kinds of asks with no steering, and each reply is checked against the ideal replies page
 * (wiki:agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html).
 *
 *   node apps/chat/scripts/blind-replies.mjs [--asks <file.json>] [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *
 * The first ask is the channel's root post and every later one a reply in its thread, as the owner asks in a channel. An ask is
 * `{text, expect}`, where `expect` is "reply" (one short Slack post) or "reaction" (no post). The agent and the room are `test: true`, so no
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

async function call(method, path, body) {
  const response = await fetch(`${server}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TABLE = /^[ \t]*\|?.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;
const words = text => text.replace(/\]\([^)]*\)/g, "]").split(/\s+/).filter(Boolean).length;
const sentences = text => text.replace(/\]\([^)]*\)/g, "]").split(/(?<=[.!?])\s+/).filter(Boolean);

/** The ideal replies page's rules that a script can read; the reader judges the tone from the printed text. */
function checks(ask, posts) {
  const text = posts.map(p => p.text).join("\n\n");
  if (ask.expect === "reaction") return [["no post, a reaction says it", posts.length === 0]];
  return [
    ["one post", posts.length === 1],
    ["no table", !TABLE.test(text)],
    ["no heading, bold or label opener", !/^#{1,6} |\*\*|^[A-Z][\w ]{0,20}:\s/m.test(text)],
    ["at most 80 words, as config/AGENTS.md rule 5", words(text) <= 80],
    ["no sentence over 35 words", sentences(text).every(s => words(s) <= 35)],
  ];
}

const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
const agent = await call("POST", "/api/agents", { name: `blind replies ${stamp}`, test: true, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.host ? { host: values.host } : {}) });
const room = await call("POST", "/api/rooms", { kind: "channel", name: `blind-replies-${stamp}`, agenda: "", members: [agent.id], test: true });
console.log(`agent ${agent.id}, room ${room.id}`);

let root;
const results = [];
for (const [index, ask] of asks.entries()) {
  const sent = await call("POST", `/api/c/${room.id}/send`, { text: ask.text, requestId: `blind-${stamp}-${index}`, ...(root ? { threadRoot: root } : {}) });
  const askId = sent.item.id;
  root ??= askId;
  const started = Date.now();
  let posts = [];
  let lastNew = 0;
  for (;;) {
    await sleep(POLL_MS);
    const thread = await call("GET", `/api/c/${room.id}/replies/${root}`);
    const now = thread.items.filter(i => i.author?.id === agent.id && i.answers === askId);
    if (now.length > posts.length) lastNew = Date.now();
    posts = now;
    const reacted = [thread.root, ...thread.items].find(i => i.id === askId)?.reactions?.some(r => r.by.some(b => b.id === agent.id));
    if (posts.length && Date.now() - lastNew > QUIET_MS) break;
    if (!posts.length && ask.expect === "reaction" && reacted && Date.now() - started > QUIET_MS) break;
    if (Date.now() - started > FIRST_MS) break;
  }
  const result = checks(ask, posts);
  const line = { ask: ask.text, askId, expect: ask.expect, seconds: Math.round((Date.now() - started) / 1000), replies: posts.map(p => p.text), checks: Object.fromEntries(result), pass: result.every(([, ok]) => ok) };
  results.push(line);
  console.log(`\n${line.pass ? "PASS" : "FAIL"} ${ask.text}\n${posts.map(p => `  > ${p.text.replace(/\n/g, "\n    ")}`).join("\n") || "  (no post)"}\n  ${result.filter(([, ok]) => !ok).map(([name]) => `failed: ${name}`).join(", ")}`);
  if (values.out) appendFileSync(values.out, `${JSON.stringify({ room: room.id, agent: agent.id, ...line })}\n`);
}
const summary = { room: room.id, root, agent: agent.id, passed: results.filter(r => r.pass).length, of: results.length, pass: results.every(r => r.pass) };
if (values.out) appendFileSync(values.out, `${JSON.stringify(summary)}\n`);
console.log(`\n${summary.pass ? "PASS" : "FAIL"} ${summary.passed}/${summary.of}, thread ${server}/#/c/${room.id}?thread=${root}`);
process.exit(summary.pass ? 0 : 1);

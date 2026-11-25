#!/usr/bin/env node
/**
 * The blind reply check of the sw-factory skill (skills/sw-factory/SKILL.md): a fresh test agent in a fresh test channel gets the owner's
 * real kinds of asks with no steering, and each reply is checked against the ideal replies page
 * (wiki:agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html).
 *
 *   node apps/chat/scripts/blind-replies.mjs [--asks <file.json> | --set lists | --set options | --set checklist | --set natural | --set promise] [--no-reaction] [--cwd <project>] [--host <box>] [--out <file.jsonl>] [--server http://127.0.0.1:5184]
 *
 * The first ask is the channel's root post and every later one a reply in its thread, as the owner asks in a channel. An ask is
 * `{text, expect, wait}`, where `expect` is "reply" (one short Slack post), "list" (a one-line answer, then nested bullets and a task list,
 * as the owner asked under p85 and p95 in #sw-factory-build on 11-20, p101), "options" (names several apps and explains one in 20 words or
 * more, with an example and how it fits the asker's product, p97), "checklist" (one post whose first version is the answer or one plain line with no open `- [ ]` steps, c234, which a later edit may fill in), "natural" (a
 * post that opens with a natural sentence, then bullets with no bare topic labels, ticks any open task by an edit, states a pick before any
 * question, p54, and puts its answer on its own first line with no 3-sentence wall, p57; natural-checks.mjs), "lookup" (a slow look-up whose
 * first post holds a fact or waits for the answer, c104), "line" (one short line with
 * no bullets) or "reaction" (no post). An ask with `room: "dm"` goes to the agent's DM as a root post instead of the channel. `wait: false` sends the next ask at
 * once, so the agent answers both together, as when the owner sent p14 and p15 7 s apart on 11-20. The agent and the room are `test: true`, so no
 * owner list shows them. Each line of --out is one ask with its replies, its checks and pass or fail; the last line is the run's summary.
 *
 * Waits: an ask waits up to 20 min for its first answer, since of 45 owner posts in channel threads by 11-20 the agent's first post came
 * at p50 36 s and p90 1,082 s, the slow ones after a hand-over to the work thread. After a post it waits 60 s with no new post before it
 * reads the answer as whole, since the gaps between one turn's posts in #dev-search-general on 11-20 were 65 ms to 7 s.
 *
 * An ask the agent neither posted on nor reacted to within those 20 min got no model answer, which is no reply that breaks a rule: its
 * line says `unanswered: true`, the asks after it are not sent and say the same, and the summary counts them as `unmeasured`, with
 * `passed` and `of` over the answered asks only. On 11-23 at 06:45 KST four sets ended with no reply after about 1,200 s an ask while 3 of
 * 42 model accounts took new work and up to 82 sessions waited, and the duty read them as 5 style notes not followed. The run exits 0 on
 * a pass, 1 on a failed answered ask and 2 when no ask was answered.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hasOpenItem, lineChecks, naturalChecks, naturalLine, narrates, overstates, promises, sentences, words } from "./natural-checks.mjs";

const { values } = parseArgs({ options: { asks: { type: "string" }, set: { type: "string" }, cwd: { type: "string" }, host: { type: "string" }, out: { type: "string" }, server: { type: "string" }, "no-reaction": { type: "boolean" },
  "first-ms": { type: "string" }, "poll-ms": { type: "string" } } });
const server = values.server ?? "http://127.0.0.1:5184";
/** `--first-ms` and `--poll-ms` shorten the first wait and the poll for test/server/owner-style.test.ts, which runs this file against a server that never answers. */
const FIRST_MS = Number(values["first-ms"] ?? 20 * 60_000);
const QUIET_MS = 60_000;
const POLL_MS = Number(values["poll-ms"] ?? 3_000);
/** A checklist post's edits come as the work thread finishes items, minutes apart, so its answer counts as whole only after this long with no edit. */
const CHECKLIST_QUIET_MS = 5 * 60_000;
/**
 * A post that still holds an open `- [ ]` waits this long with no edit instead: in both DM runs of the natural set at 19:43Z on 11-21 the work
 * thread edited the checklist again after a 5 min gap, so the jsonl missed the edits that ticked it.
 */
const OPEN_QUIET_MS = 15 * 60_000;

/** The owner's kinds of asks from #dev-search-general and #sw-factory-build on 11-20. */
const DEFAULT_ASKS = [
  { text: "did you install modern-web-guidance into this repo, and nothing else?", expect: "reply" },
  { text: "what pieces make up the skill setup agents get in this repo? where does each one live?", expect: "setup" },
  { text: "is it all working?", expect: "reply" },
  { text: "ok thanks", expect: "reaction" },
];
/** A multi-result check that should come back as a list, a one-line question that should stay a line, and a thanks; run with `--cwd` at this repo. */
const LIST_ASKS = [
  { text: "can you check where this repo stands before i ship? git state (main vs origin, uncommitted files) and whether pi-host's comm guard has tests", expect: "list" },
  { text: "which node version does this box run?", expect: "line" },
  { text: "ok thanks", expect: "reaction" },
];
/**
 * A "what do other apps do" question, as the owner asked in #sw-factory-build p90 on 11-20 ("what are some features other apps provide
 * regarding this?"), which should explain the most interesting option properly (p97), and a thanks. The ask names a product of its own:
 * asked about adding the feature "here", 2 of 3 test agents on 11-20 read it as a change to sw factory and tagged @agent factory.
 */
const OPTIONS_ASKS = [
  { text: "we're building a small team todo app. what do other apps do for snoozing a task or getting reminded about it later?", expect: "options" },
  { text: "ok thanks", expect: "reaction" },
];
/**
 * A multi-step ask and a yes/no question that should stay one line; run with `--cwd` at this repo. The owner asked for a checklist post
 * edited to done under p103 and p105 in #sw-factory-build on 11-20 (p106), and retired the open process checklist in p159 on 11-21 (c234),
 * so the first reply is now the answer or a fact known now.
 */
const CHECKLIST_ASKS = [
  { text: "before i ship, can you check: is local main in sync with origin/main, how many files are uncommitted, does pi-host's comm-guard test pass, and is any TODO left in packages/pi-host/src/durable?", expect: "checklist" },
  { text: "is this checkout on main right now?", expect: "line" },
];
/**
 * A multi-step ask in the agent's DM and one in the channel, with no hint about format, as the owner asked in dm_agent-factory p54 on 11-21
 * (msg mwqt6ry1): "todo를 리스트하는건 좋은데, 자연스럽게 해야지 메시지면 메시지 context에 맞게, channel 도중이면 channel message concept에 맞게. 그리고
 * follow-up question 물어도 돼 괜찮아 대신 primary suggestion은 꼭 두고", after a checklist post opened with "one table: Prime chat vs ..., file by
 * file." over one-word topic bullets. Both asks leave a choice open, so a follow-up question is natural. They name a tool the asker
 * wants to adopt, never sw factory, and the set runs at ~/code/symphony, a read-only upstream clone, so no agent edits a real repo.
 */
const NATURAL_ASKS = [
  { room: "dm", text: "we want to try symphony for our team's backlog. can you work out what it'd take: how it picks up issues, how it runs each agent in its workspace, and what we'd change for our setup? we track work in github issues today, not linear, so not sure if we adapt symphony or move to linear", expect: "natural" },
  { text: "before we pick symphony for the team, can you check how it retries a failed agent run, where it keeps run logs, and whether it can cap token spend per issue? also should we run it on one box or split it?", expect: "natural" },
];
/**
 * An ask whose answer takes a slow look-up of a few minutes, so the comm thread hands it over. The owner called a first reply that promised
 * its result slop on 11-25 (#1124-cost-management p21, msg mww1eid8, c104), after p17 ended "Calls per customer per day, with the success
 * rate, are coming here next.". A pass has no post or edit that promises a result: the first post holds a fact or waits for the answer.
 */
const PROMISE_ASKS = [
  { text: "how well do symphony's elixir tests cover its code? for each module under lib/, how many test cases exercise it, and which modules have none? sort the uncovered ones by line count", expect: "lookup" },
];
const SETS = { default: DEFAULT_ASKS, lists: LIST_ASKS, options: OPTIONS_ASKS, checklist: CHECKLIST_ASKS, natural: NATURAL_ASKS, promise: PROMISE_ASKS };
/** A set's own project when no --cwd is given, so the owner-style duty, which passes none, runs natural and promise at the read-only clone too. */
const SET_CWD = { natural: join(homedir(), "code/symphony"), promise: join(homedir(), "code/symphony") };
const chosen = values.asks ? JSON.parse(readFileSync(values.asks, "utf8")) : SETS[values.set ?? "default"];
if (!chosen) throw new Error(`--set is one of ${Object.keys(SETS).join(", ")}`);
/**
 * `--no-reaction` drops the "ok thanks" asks: an agent that answers one with no post and no reaction holds the run for the whole 20 min first
 * wait, as the p97 run 1 did on 11-20 (1,202 s), and the owner-style duty's precheck runs inside the chat server, which other releases restarted
 * twice within its first 45 min that day.
 */
const asks = values["no-reaction"] ? chosen.filter(ask => ask.expect !== "reaction") : chosen;

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

const BULLET = /^\s*[-*+] /;

/** Apps with a snooze or remind-later feature, mail and chat apps and the todo apps OPTIONS_ASKS asks about, which an answer names. */
const APPS = ["Slack", "Superhuman", "Gmail", "Outlook", "Linear", "Discord", "Teams", "Spark", "Hey", "Front", "Missive", "Todoist", "Notion", "Telegram", "WhatsApp", "Apple Mail", "Shortwave", "Boomerang",
  "Things 3", "Apple Reminders", "TickTick", "Asana", "Microsoft To Do", "Any\\.do", "OmniFocus", "Google Tasks", "Trello", "Jira", "ClickUp", "Basecamp"]
  .map(app => new RegExp(`\\b${app}\\b`, "i"));
/** An example: a cue word, a quoted action or a time such as "3 days". */
const EXAMPLE = /\b(e\.g\.|for example|for instance|say you|like when|you (send|pick|hit|get|set|mark|snooze)|\d+\s*(min|minutes|h|hours?|days?|am|pm)\b|tomorrow|monday)|"[^"]{3,}"|“[^”]{3,}”/i;
/** How the option fits the asker's product: "for us", "your app", "you'd", "here" and the like. */
const FITS = /\b(for us|we could|we can|we'd|our|your (app|team|todo|users)|you'd|you could|fit|here|this app|a todo app|for todos?|on a task|tasks?)\b/i;
/** The blocks of a post: a paragraph, or a top-level bullet with its nested lines. */
const blocks = text => text.split(/\n(?=\S)|\n\s*\n/).map(block => block.trim()).filter(Boolean);

/** The ideal replies page's rules that a script can read; the reader judges the tone from the printed text. */
function checks(ask, posts, asked, versions = new Map()) {
  const text = posts.map(p => p.text).join("\n\n");
  if (ask.expect === "reaction") return [["no post, a reaction says it", posts.length === 0]];
  const lines = text.split("\n").filter(line => line.trim());
  const every = posts.flatMap(p => versions.get(p.id) ?? [p.text]);
  const plain = [
    // A natural answer may add one post that asks a follow-up question, which the owner allowed in p54, and a look-up may post a fact it
    // knew at once and then the answer.
    ["one post for the posts it answers", posts.length === 1 || (ask.expect === "natural" && posts.length === 2 && posts[1].text.includes("?")) || (ask.expect === "lookup" && posts.length === 2)],
    ["no version promises a result to come", every.every(version => !promises(version))],
    ["no table", !TABLE.test(text)],
    ["no heading, bold or label opener", !/^#{1,6} |\*\*|^[A-Z][\w ]{0,20}:\s/m.test(text)],
  ];
  // A quick answer may break its two sentences into two lines, as the owner asked in p57 ("엔터, bullet point 똑바로 쓰고."), so the check
  // asks for no bullets and at most two lines rather than one line.
  if (ask.expect === "line") return [...plain, ["at most two lines with no bullets", lines.length <= 2 && lines.every(line => !BULLET.test(line))], ["at most 30 words", words(text) <= 30]];
  if (ask.expect === "options") {
    const named = APPS.filter(app => app.test(text)).length;
    // Since e3bf6439 a list of options opens with the pick and explains it in the bullets under it, so the pick's block runs on through the
    // following blocks that name no other app, as in d4's 11-22 06:44Z run: "I'd copy Linear's snooze, because ..." with its example in the
    // next bullet, "You snooze a task to Monday, a teammate comments Friday, ...".
    const parts = blocks(text);
    const deep = parts.map((block, i) => {
      const named = APPS.filter(app => app.test(block));
      if (!named.length) return undefined;
      let joined = block;
      for (const next of parts.slice(i + 1)) {
        if (APPS.some(app => app.test(next) && !named.includes(app))) break;
        joined += `\n${next}`;
      }
      return words(joined) >= 20 * named.length ? joined : undefined;
    }).filter(block => block !== undefined);
    return [
      ...plain,
      ["names at least 2 apps", named >= 2],
      ["explains an app in a block of 20 words or more per app it names", deep.length > 0],
      ["that explanation gives an example", deep.some(block => EXAMPLE.test(block))],
      ["says how it fits the asker's product", FITS.test(text)],
      ["at most 220 words", words(text) <= 220],
    ];
  }
  if (ask.expect === "checklist") {
    const first = posts[0] ? (versions.get(posts[0].id) ?? [posts[0].text])[0] : "";
    return [
      ...plain,
      // Since c234 (p159 on 11-21) the first version is the answer or a fact known now, never open process steps; a later
      // edit may fill in results, so no edit is required.
      ["the first version opens with a natural sentence", naturalLine((first.split("\n").find(line => line.trim()) ?? "").trim())],
      ["the first version narrates no plan of the agent's own", !narrates(first)],
      ["the first version holds no open - [ ] item", !hasOpenItem(first)],
      ["the last version opens with a one-line answer", lines.length > 0 && !BULLET.test(lines[0]) && words(lines[0]) <= 25],
      ["the answer line calls nothing all clear over uncommitted files it lists", !overstates(text)],
      ...lineChecks(lines),
    ];
  }
  // A setup question gets one answer line and one table (c225), so the table is wanted and its cells and any code block count no words.
  if (ask.expect === "setup") {
    const prose = text.replace(/```[\s\S]*?```/g, "").split("\n").filter(line => !/^\s*\|/.test(line)).join("\n");
    return [
      ...plain.filter(([name]) => name !== "no table"),
      ["opens with a one-line answer, not a bullet", lines.length > 0 && !BULLET.test(lines[0]) && !/^\s*\|/.test(lines[0]) && words(lines[0]) <= 25],
      ["one table of the pieces", TABLE.test(text)],
      ["at most 120 words outside the table", words(prose) <= 120],
    ];
  }
  if (ask.expect === "natural") return [...plain, ...naturalChecks(posts.map(p => versions.get(p.id) ?? [p.text]))];
  if (ask.expect === "lookup") {
    const first = posts[0] ? (versions.get(posts[0].id) ?? [posts[0].text])[0] : "";
    return [
      ...plain,
      ["the first version opens with a natural sentence", naturalLine((first.split("\n").find(line => line.trim()) ?? "").trim())],
      ["the first version narrates no plan of the agent's own", !narrates(first)],
      ["the answer gives counts", /\d/.test(text)],
      ...lineChecks(lines),
    ];
  }
  if (ask.expect === "list") {
    return [
      ...plain,
      ["opens with a one-line answer, not a bullet", lines.length > 1 && !BULLET.test(lines[0]) && words(lines[0]) <= 25],
      // Nested topic groups are allowed but not required, since the owner asked for flat short sentences in p54 on 11-21.
      ["bullets under the answer", lines.slice(1).some(line => BULLET.test(line))],
      // Since c234 a list of results may be plain bullets, so a task list is no longer required.
      ...lineChecks(lines),
    ];
  }
  return [
    ...plain,
    // A room's cap (pi-host room-post.ts ROOM_LONG_WORDS), which the owner's 92-word model post (msg mwqtp2l1) fits.
    ["at most 120 words, as a room's tell_owner check", words(text) <= 120 * asked],
    ["no sentence over 35 words", sentences(text).every(s => words(s) <= 35)],
  ];
}

/** Month, day, time to the second and 2 random letters, since two runs started in one minute on 11-20 got one channel name. */
const stamp = `${new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "")}${Math.random().toString(36).slice(2, 4)}`;
const cwd = values.cwd ?? SET_CWD[values.set];
const agent = await call("POST", "/api/agents", { name: `blind replies ${stamp}`, test: true, ...(cwd ? { cwd } : {}), ...(values.host ? { host: values.host } : {}) });
const room = await call("POST", "/api/rooms", { kind: "channel", name: `blind-replies-${stamp}`, agenda: "", members: [agent.id], test: true });
console.log(`agent ${agent.id}, room ${room.id}`);

let root;
const results = [];
/** Asks sent with `wait: false` go out at once, and the next ask waits for the answers to all of them, as when he sends two posts in a row. */
let group = [];
/** Set once an ask got no post and no reaction within its first wait; a later ask would wait behind the same turn, so it is not sent. */
let starved = false;
const write = line => {
  results.push(line);
  if (values.out) appendFileSync(values.out, `${JSON.stringify({ agent: agent.id, set: values.set ?? "default", ...line })}\n`);
};
for (const [index, ask] of asks.entries()) {
  const dm = ask.room === "dm";
  if (starved) {
    write({ ask: ask.text, askIds: [], room: dm ? agent.room : room.id, expect: ask.expect, seconds: 0, replies: [], versions: [], checks: {}, pass: false, unanswered: true });
    console.log(`\nNOT MEASURED ${ask.text}\n  (not sent, since the ask before it got no answer)`);
    continue;
  }
  const sent = await call("POST", `/api/c/${dm ? agent.room : room.id}/send`, { text: ask.text, requestId: `blind-${stamp}-${index}`, ...(root && !dm ? { threadRoot: root } : {}) });
  if (!dm) root ??= sent.item.id;
  group.push({ ...ask, id: sent.item.id, seq: sent.item.seq });
  if (ask.wait === false) continue;
  const ids = new Set(group.map(g => g.id));
  const started = Date.now();
  let posts = [];
  let lastNew = 0;
  /** Whether the agent reacted to a post of this ask, and when it first posted or reacted, which shows its model answered. */
  let reacted = false;
  let first;
  /** Every text each answer post had, in order, so a checklist's first version and its edits can be checked. */
  const versions = new Map();
  const edited = ask.expect === "checklist" || ask.expect === "natural" || ask.expect === "lookup";
  const quiet = edited ? CHECKLIST_QUIET_MS : QUIET_MS;
  const since = Math.min(...group.map(g => g.seq ?? 0));
  for (;;) {
    await sleep(POLL_MS);
    // A DM has no thread, so its answers are the agent's posts after the ask, whatever they name as answered.
    const thread = dm ? { root: undefined, items: (await call("GET", `/api/c/${agent.room}/items?limit=200`)).items.filter(i => i.kind === "message") } : await call("GET", `/api/c/${room.id}/replies/${root}`);
    const now = thread.items.filter(i => i.author?.id === agent.id && (dm ? i.seq > since : ids.has(i.answers)));
    if (now.length > posts.length) lastNew = Date.now();
    for (const post of now) {
      const seen = versions.get(post.id) ?? [];
      if (seen.at(-1) !== post.text) {
        versions.set(post.id, [...seen, post.text]);
        lastNew = Date.now();
      }
    }
    posts = now;
    reacted = [thread.root, ...thread.items].some(i => i && ids.has(i.id) && i.reactions?.some(r => r.by.some(b => b.id === agent.id)));
    if (posts.length || reacted) first ??= Math.round((Date.now() - started) / 1000);
    const open = edited && posts.some(post => /^\s*[-*+] \[ \] /m.test(post.text));
    // A look-up's first post may be a fact while its work still runs, and the agent's 👀 on the ask shows that work until the answer is in.
    const eyes = ask.expect === "lookup" && [thread.root, ...thread.items].some(i => i && ids.has(i.id) && i.reactions?.some(r => r.emoji === "👀" && r.by.some(b => b.id === agent.id)));
    if (posts.length && !eyes && Date.now() - lastNew > (open ? OPEN_QUIET_MS : quiet)) break;
    if (!posts.length && ask.expect === "reaction" && reacted && Date.now() - started > QUIET_MS) break;
    if (first === undefined && Date.now() - started > FIRST_MS) break;
    // A natural ask is a research task, and both after runs at 20:39Z on 11-21 still worked on it at 44 min.
    if (Date.now() - started > (ask.expect === "natural" || ask.expect === "lookup" ? 3 * FIRST_MS : edited ? 2 * FIRST_MS : FIRST_MS)) break;
  }
  const text = group.map(g => g.text).join(" / ");
  const result = checks(ask, posts, group.length, versions);
  // An ask that wants a reply and got no post and no reaction is not measured; a thanks that got neither is a pass, as before.
  const unanswered = first === undefined && ask.expect !== "reaction";
  if (unanswered) starved = true;
  const line = { ask: text, askIds: [...ids], room: dm ? agent.room : room.id, expect: ask.expect, seconds: Math.round((Date.now() - started) / 1000), ...(first === undefined ? {} : { first }), replies: posts.map(p => p.text), versions: posts.map(p => versions.get(p.id) ?? [p.text]), checks: Object.fromEntries(result), pass: !unanswered && result.every(([, ok]) => ok), ...(unanswered ? { unanswered: true } : {}) };
  console.log(`\n${unanswered ? "NOT MEASURED" : line.pass ? "PASS" : "FAIL"} ${text}\n${posts.map(p => `  > ${p.text.replace(/\n/g, "\n    ")}`).join("\n") || "  (no post)"}\n  ${unanswered ? `no post and no reaction within ${line.seconds} s` : result.filter(([, ok]) => !ok).map(([name]) => `failed: ${name}`).join(", ")}`);
  write(line);
  group = [];
}
const answered = results.filter(r => !r.unanswered);
const summary = { room: room.id, root, agent: agent.id, passed: answered.filter(r => r.pass).length, of: answered.length, unmeasured: results.length - answered.length, pass: answered.length > 0 && answered.every(r => r.pass) };
if (values.out) appendFileSync(values.out, `${JSON.stringify(summary)}\n`);
console.log(`\n${!summary.of ? "NOT MEASURED" : summary.pass ? "PASS" : "FAIL"} ${summary.passed}/${summary.of}${summary.unmeasured ? `, ${summary.unmeasured} not measured` : ""}, thread ${server}/#/c/${room.id}?thread=${root}`);
process.exit(!summary.of ? 2 : summary.pass ? 0 : 1);

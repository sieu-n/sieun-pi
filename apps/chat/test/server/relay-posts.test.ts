/**
 * The duty precheck `scripts/duties/relay-posts.ts` on a data dir of its own: it counts the agent posts of the window that relay the agent's
 * own work, in real rooms only, and prints them as flagged rows; a test room, a test agent's post, an archived room, an owner post, a result
 * and a post outside the window count as nothing. A progress post that answers the owner's question in its reply thread counts as nothing too,
 * and a hand-over post always counts.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firstModelAnswer, relayPosts, silentPosts } from "../../scripts/duties/relay-posts.ts";

const dir = mkdtempSync(join(tmpdir(), "apps-chat-relay-posts-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 3, 3, 0);
const HOUR = 3600_000;

const member = (agent: string) => ({ agent, wakeOn: "all", addedAt: NOW - 100 * HOUR });
const room = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "channel", name: id, purpose: "", createdAt: NOW - 100 * HOUR, archived: false, members: [member("ag_vent")], ...extra });
const post = (roomId: string, seq: number, author: string, text: string, at: number, threadRoot?: string) =>
  `${JSON.stringify({ t: "post", post: { room: roomId, id: `p${seq}`, seq, author, text, images: [], mentions: [], at, hops: 1, requestId: `r${seq}`, deliveries: [], ...(threadRoot ? { threadRoot } : {}) } })}\n`;

mkdirSync(join(dir, "rooms"));
writeFileSync(join(dir, "agents.json"), JSON.stringify({ v: 1, aliases: {}, agents: [
  { id: "ag_vent", slug: "vent", name: "vent", room: "dm_vent", workThread: "w-vent", host: "us-metal02", home: "/tmp", createdAt: 0, archived: false },
  { id: "ag_walk", slug: "walk", name: "walk", room: "dm_walk", workThread: "w-walk", host: "us-metal02", home: "/tmp", createdAt: 0, archived: false, test: true },
] }));
writeFileSync(join(dir, "rooms.json"), JSON.stringify({ v: 1, feed: {}, rooms: [
  room("ch_real"), room("ch_ask"), room("ch_walk", { test: true }), room("ch_old", { archived: true }),
  { id: "dm_vent", kind: "dm", agent: "ag_vent", createdAt: 0, archived: false },
  { id: "dm_walk", kind: "dm", agent: "ag_walk", createdAt: 0, archived: false },
] }));
const RELAY = "The vent thread is now listing every panel, including Vent, admin, Grafana and the rest, with its data, backend and a tested login, on one wiki page.";
writeFileSync(join(dir, "rooms", "ch_real.jsonl"), [
  post("ch_real", 1, "owner", "@vent list every panel, and I'll post the link once it's done", NOW - 2 * HOUR),
  post("ch_real", 2, "ag_vent", RELAY, NOW - 2 * HOUR + 30_000),
  post("ch_real", 3, "ag_vent", "Every panel is on one page now, with its data, backend and a tested login.", NOW - HOUR),
  post("ch_real", 4, "ag_vent", "I'll post the wiki link here once the list is done.", NOW - 30 * HOUR),
  post("ch_real", 5, "ag_walk", RELAY, NOW - HOUR),
].join(""));
// From 11-03: ch_14ad7a70 p39 and p40 (an answer) and ch_4dd433c3 p15 and p17 (a relay).
const ANSWER = "Yes, the search job (p56) is timing Meilisearch against our fixed SQLite search on the real data now.";
const CATCH = "The catch is Chrome shares one Instagram login, so your open Instagram tabs would flip accounts for those seconds. A job is testing whether that can be avoided.";
writeFileSync(join(dir, "rooms", "ch_ask.jsonl"), [
  post("ch_ask", 1, "owner", "@vent search plan", NOW - 5 * HOUR),
  post("ch_ask", 2, "owner", "are you working on Meilisearch then?", NOW - 5 * HOUR + 1_000, "p1"),
  post("ch_ask", 3, "ag_vent", ANSWER, NOW - 5 * HOUR + 2_000, "p1"),
  post("ch_ask", 4, "owner", "proxy가 아니라 근데 Client browser에서", NOW - 5 * HOUR + 3_000),
  post("ch_ask", 5, "ag_vent", CATCH, NOW - 5 * HOUR + 4_000),
  post("ch_ask", 6, "ag_vent", ANSWER, NOW - 5 * HOUR + 5_000, "p9"),
  post("ch_ask", 7, "ag_vent", "I'll post the wiki link here once the list is done.", NOW - 5 * HOUR + 6_000, "p1"),
].join(""));
writeFileSync(join(dir, "rooms", "dm_vent.jsonl"), post("dm_vent", 1, "ag_vent", "I passed that to the job vent integration health.", NOW - 3 * HOUR));
writeFileSync(join(dir, "rooms", "ch_walk.jsonl"), post("ch_walk", 1, "ag_vent", RELAY, NOW - HOUR));
writeFileSync(join(dir, "rooms", "ch_old.jsonl"), post("ch_old", 1, "ag_vent", RELAY, NOW - HOUR));
writeFileSync(join(dir, "rooms", "dm_walk.jsonl"), post("dm_walk", 1, "ag_walk", RELAY, NOW - HOUR));

test("relay posts count only an agent's relay lines of the window in real rooms", () => {
  const { findings, agentPosts } = relayPosts(dir, NOW, 24 * HOUR);
  assert.deepEqual(findings.map(f => [f.room, f.post, f.kind]), [
    ["ch_ask", "p5", "progress"], ["ch_ask", "p6", "progress"], ["ch_ask", "p7", "handoff"], ["dm_vent", "p1", "handoff"], ["ch_real", "p2", "progress"],
  ]);
  assert.equal(agentPosts, 7, "the result and the answer count as agent posts, the walk's and the old ones do not");
});

test("the precheck writes n, the count, the window and one flagged row per relay post to OUTPUT_FILE", () => {
  const out = join(dir, "out.json");
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../../scripts/duties/relay-posts.ts"), "--data-dir", dir, "--hours", "1000000"], {
    env: { ...process.env, OUTPUT_FILE: out },
  });
  const output = JSON.parse(readFileSync(out, "utf8")) as { n: number; metrics: Record<string, number>; flagged: { kind: string; sig: string; excerpt: string }[] };
  assert.equal(output.metrics.relay_posts_24h, 6);
  assert.equal(output.n, 8, "n is the agent posts read: the 7 of the last day and the one 30 h old");
  assert.deepEqual(output.flagged.map(f => [f.kind, f.sig]), [
    ["relay_handoff", "ch_real:p4"], ["relay_progress", "ch_ask:p5"], ["relay_progress", "ch_ask:p6"], ["relay_handoff", "ch_ask:p7"],
    ["relay_handoff", "dm_vent:p1"], ["relay_progress", "ch_real:p2"],
  ]);
  assert.match(output.flagged[5]!.excerpt, /^ch_real p2 by ag_vent, "The vent thread is now listing": /);
});

/**
 * First replies (c224): on 11-28 his #sw-factory-build p250 had only 👀 for 14 min although the comm thread's model answered 23 s after it,
 * while his p249 waited 3 min 39 s for a model account and got its reply 70 s after that.
 */
const quiet = mkdtempSync(join(tmpdir(), "apps-chat-first-reply-"));
after(() => rmSync(quiet, { recursive: true, force: true }));
const MIN = 60_000;
const said = (roomId: string, seq: number, author: string, at: number, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ t: "post", post: { room: roomId, id: `p${seq}`, seq, author, text: `post ${seq}`, images: [], mentions: [], at, hops: author === "owner" ? 0 : 1, requestId: `q${seq}`,
    deliveries: author === "owner" ? [{ target: "ag_vent", state: "delivered", attempts: 1, at, requestId: `d:${roomId}:p${seq}:ag_vent`, submission: seq, thread: "c-vent" }] : [], ...extra } })}\n`;
mkdirSync(join(quiet, "rooms"));
writeFileSync(join(quiet, "agents.json"), readFileSync(join(dir, "agents.json")));
writeFileSync(join(quiet, "rooms.json"), JSON.stringify({ v: 1, feed: {}, rooms: [
  room("ch_quiet"), room("ch_walk", { test: true }),
  { id: "dm_vent", kind: "dm", agent: "ag_vent", createdAt: 0, archived: false },
] }));
writeFileSync(join(quiet, "rooms", "ch_quiet.jsonl"), [
  said("ch_quiet", 1, "owner", NOW - 10 * HOUR),
  said("ch_quiet", 2, "ag_vent", NOW - 10 * HOUR + 40_000, { threadRoot: "p1", answers: "p1", editedAt: NOW - 5 * HOUR + 50_000 }),
  // Only 👀 for 14 min: the model answered after 23 s and the first post came with the result.
  said("ch_quiet", 3, "owner", NOW - 9 * HOUR, { reactions: [{ emoji: "👀", by: "ag_vent", at: NOW - 9 * HOUR + 28_000 }] }),
  said("ch_quiet", 4, "ag_vent", NOW - 9 * HOUR + 14 * MIN, { threadRoot: "p3", answers: "p3" }),
  // The model's first answer came after 3 min 39 s, and the reply 70 s after that.
  said("ch_quiet", 5, "owner", NOW - 8 * HOUR),
  said("ch_quiet", 6, "ag_vent", NOW - 8 * HOUR + 289_000, { threadRoot: "p5", answers: "p5" }),
  // A thanks that 👍 answers, and a post no agent got.
  said("ch_quiet", 7, "owner", NOW - 7 * HOUR, { reactions: [{ emoji: "👍", by: "ag_vent", at: NOW - 7 * HOUR + 9_000 }] }),
  said("ch_quiet", 8, "owner", NOW - 6 * HOUR, { deliveries: [] }),
  // A follow-up in p1's thread that the agent answered by an edit of its reply, 50 s later.
  said("ch_quiet", 9, "owner", NOW - 5 * HOUR, { threadRoot: "p1" }),
  // No model answer yet, 20 min on: it waits for an account.
  said("ch_quiet", 10, "owner", NOW - 20 * MIN),
  // No thread file on this box and no post: the clock starts at his post.
  said("ch_quiet", 11, "owner", NOW - 10 * MIN, { deliveries: [{ target: "ag_vent", state: "delivered", attempts: 1, at: NOW - 10 * MIN, requestId: "d:ch_quiet:p11:ag_vent", submission: 11, thread: "c-away" }] }),
  // Two minutes old: its 3 min are not over.
  said("ch_quiet", 12, "owner", NOW - 2 * MIN),
  // Outside the window.
  said("ch_quiet", 13, "owner", NOW - 30 * HOUR),
].join(""));
writeFileSync(join(quiet, "rooms", "dm_vent.jsonl"), [
  said("dm_vent", 1, "owner", NOW - 4 * HOUR, { delivery: { target: "ag_vent", state: "delivered", attempts: 1, at: NOW - 4 * HOUR, requestId: "d:p1:ag_vent", submission: 101, thread: "c-vent" }, deliveries: undefined }),
  said("dm_vent", 2, "ag_vent", NOW - 4 * HOUR + 6 * MIN),
].join(""));
writeFileSync(join(quiet, "rooms", "ch_walk.jsonl"), said("ch_walk", 1, "owner", NOW - HOUR));
/** Submission n of thread c-vent got its first model answer this long after its post; 10 has none yet, and c-away is on another box. */
const MODEL_AFTER: Record<number, number> = { 1: 2_000, 3: 23_000, 5: 219_000, 7: 1_000, 9: 1_000, 12: 1_000, 101: 3_000 };
const POSTED: Record<number, number> = { 1: NOW - 10 * HOUR, 3: NOW - 9 * HOUR, 5: NOW - 8 * HOUR, 7: NOW - 7 * HOUR, 9: NOW - 5 * HOUR, 12: NOW - 2 * MIN, 101: NOW - 4 * HOUR };
const modelAt = (thread: string, submission: number) => (thread !== "c-vent" ? undefined : MODEL_AFTER[submission] === undefined ? "none" as const : POSTED[submission]! + MODEL_AFTER[submission]!);

test("an owner post is silent when the agent's model answered and no post came within 3 min, and waited when only the model was late (owner, ch_30b50688/p4, c224)", () => {
  const { findings, ownerPosts } = silentPosts(quiet, NOW, 24 * HOUR, modelAt);
  assert.deepEqual(findings.map(f => [f.room, f.post, f.kind]), [
    ["ch_quiet", "p3", "silent"], ["ch_quiet", "p5", "waited"], ["dm_vent", "p1", "silent"], ["ch_quiet", "p10", "waited"], ["ch_quiet", "p11", "silent"],
  ]);
  assert.equal(findings[0]!.replyMs, 14 * MIN);
  assert.equal(findings[0]!.modelMs, 23_000);
  assert.equal(findings[3]!.replyMs, undefined, "no agent post yet");
  assert.equal(ownerPosts, 7, "p1, p3, p5, p9, p10 and p11 of the channel and the DM's p1: the thanks, the post no agent got, the fresh one and the old one need no reply yet");
  assert.deepEqual(silentPosts(quiet, NOW, 24 * HOUR).findings.map(f => [f.post, f.kind]), [["p3", "silent"], ["p5", "silent"], ["p1", "silent"], ["p10", "silent"], ["p11", "silent"]],
    "with no thread file to read, the clock starts at his post");
});

test("the first model answer after a delivery's input is read from the thread file, a failed answer is none, and a missing file is unknown", () => {
  const file = join(quiet, "c-vent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL); CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const entry = db.prepare("INSERT INTO entries (id, conversation_id, record) VALUES (?, 1, ?)");
  const model = (kind: string, role: string, timestamp: number, stopReason?: string) => JSON.stringify({ kind, model: [{ role, timestamp, ...(stopReason ? { stopReason } : {}) }] });
  entry.run(10, model("pi.assistant", "assistant", 1_000, "stop"));
  entry.run(11, model("pi.user", "user", 2_000));
  entry.run(12, model("pi.assistant", "assistant", 3_000, "error"));
  entry.run(13, model("pi.assistant", "assistant", 221_000, "toolUse"));
  entry.run(14, model("pi.user", "user", 230_000));
  const submission = db.prepare("INSERT INTO submissions (id, conversation_id, record) VALUES (?, 1, ?)");
  submission.run(1, JSON.stringify({ entry: 11 }));
  submission.run(2, JSON.stringify({ entry: 14 }));
  submission.run(3, JSON.stringify({ status: "queued" }));
  db.close();
  assert.equal(firstModelAnswer(file, 1), 221_000, "the refused call at 3 s is no answer");
  assert.equal(firstModelAnswer(file, 2), "none");
  assert.equal(firstModelAnswer(file, 3), "none", "a queued input has no entry yet");
  assert.equal(firstModelAnswer(file, 4), undefined);
  assert.equal(firstModelAnswer(join(quiet, "c-away.sqlite"), 1), undefined);
});

test("the precheck counts the silent posts as no_first_reply_3min_24h, flags each, and counts the waits with no flag", () => {
  const threads = join(quiet, "threads");
  mkdirSync(threads);
  const db = new DatabaseSync(join(threads, "c-vent.sqlite"));
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL); CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  db.prepare("INSERT INTO submissions (id, conversation_id, record) VALUES (3, 1, ?)").run(JSON.stringify({ entry: 30 }));
  db.prepare("INSERT INTO entries (id, conversation_id, record) VALUES (31, 1, ?)").run(JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", timestamp: NOW - 9 * HOUR + 23_000, stopReason: "toolUse" }] }));
  db.prepare("INSERT INTO submissions (id, conversation_id, record) VALUES (5, 1, ?)").run(JSON.stringify({ entry: 50 }));
  db.prepare("INSERT INTO entries (id, conversation_id, record) VALUES (51, 1, ?)").run(JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", timestamp: NOW - 8 * HOUR + 219_000, stopReason: "stop" }] }));
  db.close();
  const out = join(quiet, "out.json");
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../../scripts/duties/relay-posts.ts"), "--data-dir", quiet, "--threads-dir", threads, "--hours", "1000000"], { env: { ...process.env, OUTPUT_FILE: out } });
  const output = JSON.parse(readFileSync(out, "utf8")) as { metrics: Record<string, number>; flagged: { kind: string; sig: string; excerpt: string }[] };
  const mine = output.flagged.filter(f => f.kind === "no_first_reply");
  assert.ok(mine.some(f => f.sig === "ch_quiet:p3:reply" && /first agent post 14\.0 min after his post, the agent's first model answer 0\.4 min after it/.test(f.excerpt)), JSON.stringify(mine));
  assert.ok(!mine.some(f => f.sig === "ch_quiet:p5:reply"), "a post that waited for the model is no finding");
  assert.equal(output.metrics.no_first_reply_3min_24h, mine.length);
  assert.ok(output.metrics.waited_for_model_24h! >= 1 && output.metrics.owner_posts_24h! >= mine.length);
});

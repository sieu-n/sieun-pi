/**
 * Duty precheck: relay and progress posts in the owner's real rooms (owner's words, #sw-factory-build, 11-03, msg mw02d0du: "이딴건 말하면
 * 안되겠지? 계속 usage pattern 감시하고, 실제 slack처럼 동작하도록 해"). It reads apps/chat's room logs and counts the agent posts of the last
 * 24 h that relay the agent's own work instead of giving a result (`packages/pi-host/src/durable/relay-line.ts`), such as vent's "The vent
 * thread is now listing every panel, ...". It counts as pi-host's comm guard refuses (`comm-guard.ts`): a hand-over post always, and a
 * progress post unless the owner's newest post before it in the same reply thread (else the room) asks a question. The target is 0. A walk's
 * test rooms and test agents, and archived rooms, are left out.
 *
 * Its output's `n` is the count of agent posts it read in the window.
 *
 * It also counts the owner posts of the window that got no first reply (owner's words, ch_30b50688/p4, 11-19, c224: "이런 메시지 보면 일단
 * 일차적으로 보고 ~1분 안에 알겠다고 답장해"): `no_first_reply_3min_24h` is the posts whose agent had its first model answer and then posted
 * nothing in his post's thread for 3 min, and the target is 0. From 11-25 to 11-28 the role text told a comm thread to post nothing when its
 * first look found no fact, and 9 of his 88 posts that needed a reply had such a turn: his #sw-factory-build p250 waited 14 min with only 👀
 * (~/work/first-reply/measure.md). The 3 min are three times the about one minute he asks for, and each of those 9 turns had ended 11 to
 * 120 s after his post. The clock starts at the comm thread's first model answer after the post's input, read only from its pi-host
 * thread file, because a wait for a model account is not a writing problem: 11 of the 20 posts that waited over 3 min in those days waited
 * for an account, a median of 64 min. Those posts are `waited_for_model_24h`, which has no target (c250). A post an agent reaction other
 * than 👀 answers, such as 👍 on "ok thanks", needs no reply, and neither does a post no agent got.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/relay-posts.ts [--data-dir <dir>] [--threads-dir <dir>] [--hours 24]
 * The data dir defaults to APPS_CHAT_DATA_DIR, else ~/.pi/agent/chat. Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, writeFileSync } from "node:fs";
import { isMain } from "./main-module.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { asks } from "../../../../packages/pi-host/src/durable/comm-guard.ts";
import { relayWords } from "../../../../packages/pi-host/src/durable/relay-line.ts";
import { AgentStore, type RoomPost } from "../../server/agent-store.ts";

export interface RelayFinding { room: string; post: string; author: string; at: number; kind: string; words: string; text: string }

/** Whether the owner's newest post before `post` in its reply thread, else in the room, asks a question; a job's test send asks nothing. */
function ownerAsked(posts: readonly RoomPost[], post: RoomPost): boolean {
  const thread = post.threadRoot;
  const last = posts.findLast(p => p.author === "owner" && p.at <= post.at && (!thread || p.threadRoot === thread || p.id === thread));
  return !!last && !last.testSend && asks(last.text);
}

/** The relay posts of every real room in the window ending at `now`, and how many agent posts the window held. */
export function relayPosts(dir: string, now: number, windowMs: number): { findings: RelayFinding[]; agentPosts: number } {
  const store = new AgentStore(dir);
  const findings: RelayFinding[] = [];
  let agentPosts = 0;
  for (const room of store.rooms.rooms) {
    if (room.archived || store.isTest(room.id)) continue;
    const posts = store.postsOf(room.id);
    for (const post of posts) {
      if (post.author === "owner" || post.testSend || store.isTest(post.author) || post.at < now - windowMs || post.at > now) continue;
      agentPosts++;
      const relay = relayWords(post.text);
      if (relay && !(relay.kind === "progress" && ownerAsked(posts, post))) findings.push({ room: room.id, post: post.id, author: post.author, at: post.at, kind: relay.kind, words: relay.words, text: post.text });
    }
  }
  return { findings: findings.sort((a, b) => a.at - b.at), agentPosts };
}

/** How long after the agent's first model answer a first reply may come; see the file comment for the measurement behind it. */
export const FIRST_REPLY_MS = 180_000;

export interface SilentFinding { room: string; post: string; at: number; to: string[]; kind: "silent" | "waited"; replyMs?: number; modelMs?: number; text: string }

/** When a delivery's thread first had a model answer: a time, "none" while it has had none, or undefined when its thread file is not on this box. */
export type ModelAnswer = number | "none" | undefined;

/**
 * When the comm thread's model first answered after a delivery's input, read only from its pi-host thread file. An answer that failed,
 * such as a refused account, is no answer, and an input still queued has none.
 */
export function firstModelAnswer(file: string, submission: number): ModelAnswer {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sub = db.prepare("SELECT conversation_id AS conversation, json_extract(record, '$.entry') AS entry FROM submissions WHERE id = ?").get(submission) as { conversation: number; entry: number | null } | undefined;
    if (!sub) return undefined;
    if (sub.entry === null) return "none";
    const row = db.prepare("SELECT json_extract(record, '$.model[0].timestamp') AS at FROM entries WHERE conversation_id = ? AND id > ? AND json_extract(record, '$.kind') = 'pi.assistant' " +
      "AND json_extract(record, '$.model[0].stopReason') IS NOT 'error' ORDER BY id LIMIT 1").get(sub.conversation, sub.entry) as { at: number | null } | undefined;
    return row?.at ?? "none";
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * The owner posts of every real room in the window ending at `now` that had no first reply `FIRST_REPLY_MS` after his post, and how many
 * owner posts that needed a reply the window held. A reply is an agent post that `answers` his post, or one after it in its thread (in its
 * DM), or an agent's edit after it of a post there, as a comm thread fills in its first reply. A post is `silent` when the agent's model
 * had answered and no reply came within `FIRST_REPLY_MS` of that, and `waited` when the reply was late only because the model's first
 * answer was or has not come. `modelAt` gives that first answer for a delivery; with no thread file on this box the clock starts at his post.
 */
export function silentPosts(dir: string, now: number, windowMs: number, modelAt: (thread: string, submission: number) => ModelAnswer = () => undefined): { findings: SilentFinding[]; ownerPosts: number } {
  const store = new AgentStore(dir);
  const findings: SilentFinding[] = [];
  let ownerPosts = 0;
  for (const room of store.rooms.rooms) {
    if (room.archived || store.isTest(room.id)) continue;
    const posts = store.postsOf(room.id);
    for (const post of posts) {
      if (post.author !== "owner" || post.testSend || post.deletedAt !== undefined || post.at < now - windowMs || post.at > now - FIRST_REPLY_MS) continue;
      const deliveries = (post.deliveries ?? (post.delivery ? [post.delivery] : [])).filter(d => d.state === "delivered" && !d.testSend && !store.isTest(d.target));
      if (!deliveries.length) continue;
      const starts = deliveries.map(d => (d.thread !== undefined && d.submission !== undefined ? modelAt(d.thread, d.submission) : undefined));
      const known = starts.filter(at => typeof at === "number");
      const modelStart = known.length ? Math.min(...known) : undefined;
      const root = post.threadRoot ?? post.id;
      const theirs = (p: RoomPost): boolean => p.author !== "owner" && !store.isTest(p.author) && p.deletedAt === undefined && (room.kind === "dm" || p.threadRoot === root || p.id === root);
      const replies = posts.flatMap(p => {
        if (p.author === "owner" || p.deletedAt !== undefined) return [];
        if (p.at > post.at && (p.answers === post.id || theirs(p))) return [p.at];
        return theirs(p) && p.editedAt !== undefined && p.editedAt > post.at ? [p.editedAt] : [];
      });
      const replyAt = replies.length ? Math.min(...replies) : undefined;
      if ((post.reactions ?? []).some(r => r.by !== "owner" && r.emoji !== "👀" && r.at - (modelStart ?? post.at) <= FIRST_REPLY_MS)) continue;
      ownerPosts++;
      if (replyAt !== undefined && replyAt - post.at <= FIRST_REPLY_MS) continue;
      const base = { room: room.id, post: post.id, at: post.at, to: deliveries.map(d => d.target), text: post.text, ...(replyAt !== undefined ? { replyMs: replyAt - post.at } : {}), ...(modelStart !== undefined ? { modelMs: modelStart - post.at } : {}) };
      const waited = modelStart !== undefined ? (replyAt ?? now) - modelStart <= FIRST_REPLY_MS : starts.includes("none");
      findings.push({ ...base, kind: waited ? "waited" : "silent" });
    }
  }
  return { findings: findings.sort((a, b) => a.at - b.at), ownerPosts };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "threads-dir": { type: "string" }, hours: { type: "string" } } });
  const dir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const windowMs = Number(values.hours ?? 24) * 3600_000;
  const threadsDir = resolve(values["threads-dir"] ?? join(homedir(), ".prime/agent/pi-host/durable/threads"));
  const now = Date.now();
  const { findings, agentPosts } = relayPosts(dir, now, windowMs);
  const quiet = silentPosts(dir, now, windowMs, (thread, submission) => firstModelAnswer(join(threadsDir, `${thread}.sqlite`), submission));
  const silent = quiet.findings.filter(f => f.kind === "silent");
  const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
  const output = {
    n: agentPosts,
    metrics: {
      relay_posts_24h: findings.length, agent_posts_24h: agentPosts,
      no_first_reply_3min_24h: silent.length, waited_for_model_24h: quiet.findings.length - silent.length, owner_posts_24h: quiet.ownerPosts,
    },
    windowMs: { relay_posts_24h: windowMs, no_first_reply_3min_24h: windowMs },
    flagged: [
      ...findings.map(f => ({
        kind: `relay_${f.kind}`, at: f.at, sig: `${f.room}:${f.post}`,
        excerpt: `${f.room} ${f.post} by ${f.author}, "${f.words}": ${f.text.slice(0, 200)}`,
      })),
      // A post that waited for the model is in the count above and is no finding: nothing in the agent's text causes it (c250).
      ...silent.map(f => ({
        kind: "no_first_reply", at: f.at, sig: `${f.room}:${f.post}:reply`,
        excerpt: `${f.room} ${f.post} to ${f.to.join(", ")}: ${f.replyMs === undefined ? "no agent post yet" : `first agent post ${minutes(f.replyMs)} after his post`}, the agent's first model answer ${f.modelMs === undefined ? "not known on this box" : `${minutes(f.modelMs)} after it`}: ${f.text.slice(0, 160)}`,
      })),
    ],
  };
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

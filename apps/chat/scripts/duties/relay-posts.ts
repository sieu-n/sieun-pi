/**
 * Duty precheck: relay and progress posts in the owner's real rooms (owner's words, #sw-factory-build, 11-03, msg mw02d0du: "이딴건 말하면
 * 안되겠지? 계속 usage pattern 감시하고, 실제 slack처럼 동작하도록 해"). It reads apps/chat's room logs and counts the agent posts of the last
 * 24 h that relay the agent's own work instead of giving a result (`packages/pi-host/src/durable/relay-line.ts`), such as vent's "The vent
 * thread is now listing every panel, ...". The target is 0. A walk's test rooms and test agents, and archived rooms, are left out.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/relay-posts.ts [--data-dir <dir>] [--hours 24]
 * The data dir defaults to APPS_CHAT_DATA_DIR, else ~/.pi/agent/chat. Without OUTPUT_FILE the result prints to stdout.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { relayWords } from "../../../../packages/pi-host/src/durable/relay-line.ts";
import { AgentStore } from "../../server/agent-store.ts";

export interface RelayFinding { room: string; post: string; author: string; at: number; kind: string; words: string; text: string }

/** The relay posts of every real room in the window ending at `now`, and how many agent posts the window held. */
export function relayPosts(dir: string, now: number, windowMs: number): { findings: RelayFinding[]; agentPosts: number } {
  const store = new AgentStore(dir);
  const findings: RelayFinding[] = [];
  let agentPosts = 0;
  for (const room of store.rooms.rooms) {
    if (room.archived || store.isTest(room.id)) continue;
    for (const post of store.postsOf(room.id)) {
      if (post.author === "owner" || post.testSend || store.isTest(post.author) || post.at < now - windowMs || post.at > now) continue;
      agentPosts++;
      const relay = relayWords(post.text);
      if (relay) findings.push({ room: room.id, post: post.id, author: post.author, at: post.at, kind: relay.kind, words: relay.words, text: post.text });
    }
  }
  return { findings: findings.sort((a, b) => a.at - b.at), agentPosts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, hours: { type: "string" } } });
  const dir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const windowMs = Number(values.hours ?? 24) * 3600_000;
  const { findings, agentPosts } = relayPosts(dir, Date.now(), windowMs);
  const output = {
    metrics: { relay_posts_24h: findings.length, agent_posts_24h: agentPosts },
    windowMs: { relay_posts_24h: windowMs },
    flagged: findings.map(f => ({
      kind: `relay_${f.kind}`, at: f.at, sig: `${f.room}:${f.post}`,
      excerpt: `${f.room} ${f.post} by ${f.author}, "${f.words}": ${f.text.slice(0, 200)}`,
    })),
  };
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

/**
 * Duty precheck of the common duty "Area review", which every sw factory agent gets at create (server/common-duties.ts). The owner, c249,
 * #sw-factory-build p234 (11-26): "every day checks their area of responsiblity and proactively (as an actual person would) watch and
 * maintain dashboards, identify issues, act on issues, clean up (so product and codebase is always state-of-the-art) and self-improve:
 * llm-wiki, agent file update & stale 쳐내고, common user frustration point들 반복하지 않도록".
 *
 * The review itself is the duty job's work, so every run hands off one `area_review` item, which starts the job each day. The precheck gives
 * that job what a person would read first:
 *   corrections_unsaved, the headline: the owner's corrections in force (corrections ledger) made in this agent's rooms, whose id the agent's
 *     own memory store names nowhere, so the same frustration can come back (target 0). Each one is flagged with its rule.
 *   owner_posts_24h: the owner's posts of the last 24 h in the agent's DM, or naming the agent in its rooms, each flagged with its text.
 *   wiki_pages_touched_24h and memory_changed_24h: files in the agent's folder (its llm-wiki space agents/<slug>/) and memory entries
 *     changed in the last 24 h, so agent factory's d7 can read whether yesterday's review left work behind.
 *
 * Usage: OUTPUT_FILE=<file> node <apps/chat>/scripts/duties/area-review.ts --agent <agent id> [--db <chat.sqlite>] [--agents-dir <dir>]
 *   [--ledger <corrections.json>]
 * It runs with plain node (type stripping) and imports only node: modules, so its cwd can be the agent's own project, where the duty job
 * then works. Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const DAY_MS = 86_400_000;

interface Flag { kind: string; at?: number; sig?: string; excerpt: string; handOff?: true }
interface Correction { id: string; status?: string; rule: string; at?: string; chat?: { name?: string } }
interface AgentRow { id: string; slug: string; name: string; room?: string; comm?: Record<string, string> }
interface MemoryEntry { title?: string; content?: string; updated_at?: string }
interface Post { author?: string; text?: string; at?: number; mentions?: string[]; id?: string }
export interface AreaReview { metrics: Record<string, number>; flagged: Flag[] }

/** The corrections in force made in this agent's rooms: the ledger names each by its chat, "<agent name> · <room>". */
export function agentCorrections(ledger: readonly Correction[], agentName: string): Correction[] {
  const prefix = `${agentName} · `;
  return ledger.filter(c => c.status !== "retired" && typeof c.chat?.name === "string" && (c.chat.name === agentName || c.chat.name.startsWith(prefix)));
}

/** The review's measure, from what the agent's store, folder and rooms hold, as of `now`. */
export function areaReview(input: {
  agent: AgentRow; corrections: readonly Correction[]; memory: Record<string, MemoryEntry>; posts: readonly (Post & { room: string })[];
  folderTimes: readonly { path: string; mtimeMs: number }[]; now: number;
}): AreaReview {
  const { agent, now } = input;
  const day = new Date(now).toISOString().slice(0, 10);
  const memoryText = Object.entries(input.memory).map(([id, e]) => `${id} ${e.title ?? ""} ${e.content ?? ""}`).join("\n");
  const unsaved = agentCorrections(input.corrections, agent.name).filter(c => !new RegExp(`\\b${c.id}\\b`).test(memoryText));
  const ownerPosts = input.posts.filter(p => p.author === "owner" && typeof p.at === "number" && now - p.at <= DAY_MS &&
    (p.room === agent.room || (p.mentions ?? []).includes(agent.id)));
  const flagged: Flag[] = [
    {
      kind: "area_review", sig: `${agent.id}:${day}`, handOff: true,
      excerpt: `The daily review of ${agent.name}'s area: watch its dashboards and live product, find issues and act on them, clean up product and code, ` +
        "and self-improve: update its llm-wiki pages, agent files and memory, prune stale entries, and keep the owner's corrections and frustrations below from repeating.",
    },
    ...unsaved.map((c): Flag => ({ kind: "correction_unsaved", sig: c.id, ...(c.at ? { at: Date.parse(c.at) } : {}), excerpt: `${c.id}: ${c.rule}`.slice(0, 400) })),
    ...ownerPosts.map((p): Flag => ({ kind: "owner_post", at: p.at, sig: `${p.room}/${p.id}`, excerpt: `${p.room} ${p.id}: ${(p.text ?? "").replace(/\s+/g, " ").slice(0, 300)}` })),
  ];
  return {
    metrics: {
      corrections_unsaved: unsaved.length,
      owner_posts_24h: ownerPosts.length,
      wiki_pages_touched_24h: input.folderTimes.filter(f => now - f.mtimeMs <= DAY_MS && /\.(html|md)$/.test(f.path)).length,
      memory_changed_24h: Object.values(input.memory).filter(e => e.updated_at && now - Date.parse(e.updated_at) <= DAY_MS).length,
    },
    flagged,
  };
}

/** Every file under the agent's folder except its jobs' session pages, with its change time. */
function folderTimes(dir: string): { path: string; mtimeMs: number }[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; mtimeMs: number }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "jobs" && entry.name !== "harness") walk(path); }
      else if (entry.isFile()) out.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(dir);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { agent: { type: "string" }, db: { type: "string" }, "agents-dir": { type: "string" }, ledger: { type: "string" } } });
  if (!values.agent) throw new Error("--agent <agent id> names the agent whose area this reviews");
  const dbPath = values.db ?? join(process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), "chat.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT body FROM agents_agents WHERE id = ?").get(values.agent) as { body: string } | undefined;
  if (!row) throw new Error(`no agent ${values.agent} in ${dbPath}`);
  const agent = JSON.parse(row.body) as AgentRow;
  const rooms = [...new Set([agent.room, ...Object.keys(agent.comm ?? {})].filter((r): r is string => !!r))];
  const since = Date.now() - DAY_MS;
  const posts: (Post & { room: string })[] = [];
  const read = db.prepare("SELECT body FROM posts WHERE room = ? ORDER BY ord DESC LIMIT 400");
  for (const room of rooms) {
    for (const { body } of read.all(room) as { body: string }[]) {
      const post = JSON.parse(body) as Post;
      if ((post.at ?? 0) >= since) posts.push({ ...post, room });
    }
  }
  db.close();
  const agentDir = join(values["agents-dir"] ?? join(homedir(), ".pi/agent/agents"), agent.slug);
  const harness = join(agentDir, "harness/harness_state.json");
  const memory = existsSync(harness) ? ((JSON.parse(readFileSync(harness, "utf8")) as { entries?: { memory?: Record<string, MemoryEntry> } }).entries?.memory ?? {}) : {};
  const ledgerPath = values.ledger ?? join(homedir(), ".prime/agent/browser-chat/corrections.json");
  const corrections = existsSync(ledgerPath) ? ((JSON.parse(readFileSync(ledgerPath, "utf8")) as { corrections?: Correction[] }).corrections ?? []) : [];
  const result = areaReview({ agent, corrections, memory, posts, folderTimes: folderTimes(agentDir), now: Date.now() });
  const json = JSON.stringify(result, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

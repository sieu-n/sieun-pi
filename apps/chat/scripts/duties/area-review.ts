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
 *   owner_posts_24h: the owner's posts of the last 24 h in the agent's DM, or naming the agent in its rooms, that the agent has not answered
 *     (`answeredBy`). Each of his posts is flagged with its text and its state, answered with the reply's post id or not, and
 *     owner_posts_answered_24h counts the answered ones.
 *   wiki_pages_touched_24h and memory_changed_24h: files in the agent's folder (its llm-wiki space agents/<slug>/) and memory entries
 *     changed in the last 24 h, so agent factory's d7 can read whether yesterday's review left work behind.
 *
 * Usage: OUTPUT_FILE=<file> node <apps/chat>/scripts/duties/area-review.ts --agent <agent id> [--db <chat.sqlite>] [--agents-dir <dir>]
 *   [--ledger <corrections.json>] [--server http://127.0.0.1:5184] [--box <this box>]
 * An agent on another box (its `host`) has its folder read through the chat server's folder route (`remoteFolder`).
 * It runs with plain node (type stripping) and imports only node: modules and repo files by relative path, so its cwd can be the agent's own
 * project, where the duty job then works. Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isMain } from "./main-module.ts";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { listMemory } from "../../../../packages/pi-harness/src/core/memory-store.ts";
import { MEMORY_KEEP } from "../../server/common-duties.ts";

const DAY_MS = 86_400_000;

interface Flag { kind: string; at?: number; sig?: string; excerpt: string; handOff?: true; host?: string; answeredBy?: string | null }
interface Correction { id: string; status?: string; rule: string; at?: string; chat?: { name?: string } }
interface AgentRow { id: string; slug: string; name: string; room?: string; comm?: Record<string, string>; host?: string }
interface MemoryEntry { title?: string; content?: string; updated_at?: string }
interface Post { author?: string; text?: string; at?: number; mentions?: string[]; id?: string; threadRoot?: string; answers?: string; testSend?: unknown }
export interface AreaReview { metrics: Record<string, number>; flagged: Flag[] }

/** The corrections in force made in this agent's rooms: the ledger names each by its chat, "<agent name> · <room>". */
export function agentCorrections(ledger: readonly Correction[], agentName: string): Correction[] {
  const prefix = `${agentName} · `;
  return ledger.filter(c => c.status !== "retired" && typeof c.chat?.name === "string" && (c.chat.name === agentName || c.chat.name.startsWith(prefix)));
}

/** The review's measure, from what the agent's store, folder and rooms hold, as of `now`. */
/**
 * The agent's post that answers an owner post: one that names it in `answers` (the turn's or its reply_to's owner post), else the agent's
 * first later post in the same thread. On 11-26 fable auditor's first Area review flagged 12 owner posts, and the agent had answered all 12.
 */
export function answeredBy(post: Post & { room: string }, posts: readonly (Post & { room: string })[], agent: string): string | undefined {
  const thread = post.threadRoot ?? post.id;
  const mine = posts.filter(p => p.room === post.room && p.author === agent && p.id).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // A reply to a thread post sits in that thread; a reply to a top-level post sits in its thread or at the top level after it.
  const inThread = (p: Post): boolean => post.threadRoot ? p.threadRoot === thread : p.threadRoot === post.id || !p.threadRoot;
  return (mine.find(p => p.answers === post.id) ?? mine.find(p => (p.at ?? 0) > (post.at ?? 0) && inThread(p)))?.id;
}

export function areaReview(input: {
  agent: AgentRow; corrections: readonly Correction[]; memory: Record<string, MemoryEntry>; posts: readonly (Post & { room: string })[];
  folderTimes: readonly { path: string; mtimeMs: number }[]; now: number;
}): AreaReview {
  const { agent, now } = input;
  const day = new Date(now).toISOString().slice(0, 10);
  const memoryText = Object.entries(input.memory).map(([id, e]) => `${id} ${e.title ?? ""} ${e.content ?? ""}`).join("\n");
  const unsaved = agentCorrections(input.corrections, agent.name).filter(c => !new RegExp(`\\b${c.id}\\b`).test(memoryText));
  const ownerPosts = input.posts.filter(p => p.author === "owner" && !p.testSend && typeof p.at === "number" && now - p.at <= DAY_MS &&
    (p.room === agent.room || (p.mentions ?? []).includes(agent.id)));
  const answers = new Map(ownerPosts.map(p => [`${p.room}/${p.id}`, answeredBy(p, input.posts, agent.id)]));
  const unanswered = ownerPosts.filter(p => !answers.get(`${p.room}/${p.id}`));
  const flagged: Flag[] = [
    {
      kind: "area_review", sig: `${agent.id}:${day}`, handOff: true,
      excerpt: `The daily review of ${agent.name}'s area: watch its dashboards and live product, find issues and act on them, clean up product and code, ` +
        `and self-improve: update its llm-wiki pages, agent files and memory, prune stale entries, and keep the owner's corrections and frustrations below from repeating. ${MEMORY_KEEP}`,
    },
    ...unsaved.map((c): Flag => ({ kind: "correction_unsaved", sig: c.id, ...(c.at ? { at: Date.parse(c.at) } : {}), excerpt: `${c.id}: ${c.rule}`.slice(0, 400) })),
    ...ownerPosts.map((p): Flag => {
      const reply = answers.get(`${p.room}/${p.id}`);
      return {
        kind: "owner_post", at: p.at, sig: `${p.room}/${p.id}`, answeredBy: reply ?? null,
        excerpt: `${p.room} ${p.id} (${reply ? `answered by ${agent.name} in ${reply}` : "not answered"}): ${(p.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`,
      };
    }),
  ];
  return {
    metrics: {
      corrections_unsaved: unsaved.length,
      owner_posts_24h: unanswered.length,
      owner_posts_answered_24h: ownerPosts.length - unanswered.length,
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

/** What the review reads from the agent's folder: its memory store and file times, or the box that did not answer. */
export type FolderRead = { memory: Record<string, MemoryEntry>; folderTimes: { path: string; mtimeMs: number }[] } | { away: string };

/** The folder on this box: the store and every file's change time. */
export function localFolder(dir: string): FolderRead {
  const harness = join(dir, "harness/harness_state.json");
  const memory: Record<string, MemoryEntry> = existsSync(harness) ? ((JSON.parse(readFileSync(harness, "utf8")) as { entries?: { memory?: Record<string, MemoryEntry> } }).entries?.memory ?? {}) : {};
  // Memory entries live in memory.sqlite beside the file (pi-harness memory-store.ts); the file holds only ones an older writer left.
  for (const entry of listMemory(join(dir, "harness"))) memory[entry.id] = entry;
  return { memory, folderTimes: folderTimes(dir) };
}

interface FolderAnswer {
  brief?: { path: string; modifiedAt: number | null }; workingMemory?: { path: string; modifiedAt: number | null };
  memory?: { entries?: { id: string; kind: string; title?: string; content?: string; updatedAt?: string }[] };
}

/**
 * The folder of an agent on another box, through the chat server's GET /api/agents/:id/folder, which reads that box's files through its
 * relay (server/agent-folder.ts `AgentFolders`). 5180 designer's folder is on the Mac, so the 11-26 review read metal's empty
 * ~/.pi/agent/agents/5180-designer and found no memory. The route gives the brief's and working memory's change times only, so those two
 * stand in for the folder's pages. A box that does not answer is away.
 */
export async function remoteFolder(server: string, agent: { id: string; host?: string }, get: typeof fetch = fetch): Promise<FolderRead> {
  const away = { away: agent.host ?? "its box" };
  let answer: FolderAnswer;
  try {
    // Half the Area review precheck's 60 s timeout (server/common-duties.ts), so a box that hangs still leaves time to write the output.
    const res = await get(`${server}/api/agents/${encodeURIComponent(agent.id)}/folder`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return away;
    answer = await res.json() as FolderAnswer;
    // The folder carries only the newest memory page; the memory route reads the whole store.
    const all = await get(`${server}/api/agents/${encodeURIComponent(agent.id)}/memory?limit=1000000`, { signal: AbortSignal.timeout(30_000) });
    const page = all.ok ? (await all.json()) as { entries?: unknown } : {};
    if (Array.isArray(page.entries)) {
      answer.memory = { entries: [...(answer.memory?.entries ?? []).filter(entry => entry.kind !== "memory"), ...(page.entries as NonNullable<NonNullable<FolderAnswer["memory"]>["entries"]>)] };
    }
  } catch {
    return away;
  }
  const memory = Object.fromEntries((answer.memory?.entries ?? []).filter(entry => entry.kind === "memory")
    .map(entry => [entry.id, { title: entry.title, content: entry.content, ...entry.updatedAt ? { updated_at: entry.updatedAt } : {} }]));
  const folderTimes = [answer.brief, answer.workingMemory].flatMap(file => file?.modifiedAt ? [{ path: file.path, mtimeMs: file.modifiedAt }] : []);
  return { memory, folderTimes };
}

/**
 * The review with its folder read: the measure, with `n`, the memory entries and folder files it read. When the agent's box is away, the
 * output leaves the folder counts out, so they read not measured, n is 0 and a `host_away` item names the box. The duty system reruns the
 * duty once the box is back, and agent factory's d7 and fable auditor's sweep skip the run. From 11-26 to 11-28 5180 designer's runs wrote
 * 999999 for corrections_unsaved while the Mac slept, and each one read as an error with that number.
 */
export function reviewOf(input: Omit<Parameters<typeof areaReview>[0], "memory" | "folderTimes"> & { folder: FolderRead }): AreaReview & { n: number } {
  const { folder, ...rest } = input;
  if ("away" in folder) {
    const posts = areaReview({ ...rest, memory: {}, folderTimes: [] });
    const { owner_posts_24h, owner_posts_answered_24h } = posts.metrics;
    return {
      metrics: { owner_posts_24h: owner_posts_24h!, owner_posts_answered_24h: owner_posts_answered_24h! }, n: 0,
      flagged: [
        ...posts.flagged.filter(flag => flag.kind === "owner_post"),
        { kind: "host_away", host: folder.away, sig: `${rest.agent.id}:host_away`, excerpt: `${rest.agent.name}'s box ${folder.away} did not answer, so its folder and memory were not read` },
      ],
    };
  }
  return { ...areaReview({ ...rest, memory: folder.memory, folderTimes: folder.folderTimes }), n: Object.keys(folder.memory).length + folder.folderTimes.length };
}

/**
 * The whole review of one agent, as the script runs it: reads the agent and its rooms' posts from chat.sqlite, its folder on its own box
 * and the corrections ledger. Another precheck, such as API portal's legacy/prime/user-history/scripts/duties/portal-area-review.ts, can
 * import and call this; importing the file runs nothing (`isMain`).
 */
export async function runAreaReview(options: { agent: string; db?: string; agentsDir?: string; ledger?: string; server?: string; box?: string; now?: number }): Promise<AreaReview & { n: number }> {
  const now = options.now ?? Date.now();
  const dbPath = options.db ?? join(process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), "chat.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT body FROM agents_agents WHERE id = ?").get(options.agent) as { body: string } | undefined;
  if (!row) {
    db.close();
    throw new Error(`no agent ${options.agent} in ${dbPath}`);
  }
  const agent = JSON.parse(row.body) as AgentRow;
  const rooms = [...new Set([agent.room, ...Object.keys(agent.comm ?? {})].filter((r): r is string => !!r))];
  const since = now - DAY_MS;
  const posts: (Post & { room: string })[] = [];
  const read = db.prepare("SELECT body FROM posts WHERE room = ? ORDER BY ord DESC LIMIT 400");
  for (const room of rooms) {
    for (const { body } of read.all(room) as { body: string }[]) {
      const post = JSON.parse(body) as Post;
      if ((post.at ?? 0) >= since) posts.push({ ...post, room });
    }
  }
  db.close();
  // An agent on another box keeps its folder there; the chat server's box is APPS_CHAT_BOX or the hostname, as server/config.ts reads it.
  const box = options.box ?? process.env.APPS_CHAT_BOX ?? hostname();
  const server = options.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const folder = agent.host && agent.host !== box ? await remoteFolder(server, agent) : localFolder(join(options.agentsDir ?? join(homedir(), ".pi/agent/agents"), agent.slug));
  const ledgerPath = options.ledger ?? join(homedir(), ".prime/agent/browser-chat/corrections.json");
  const corrections = existsSync(ledgerPath) ? ((JSON.parse(readFileSync(ledgerPath, "utf8")) as { corrections?: Correction[] }).corrections ?? []) : [];
  return reviewOf({ agent, corrections, posts, folder, now });
}

// The chat server runs this through the current symlink, and node resolves the main module to the release folder, so `isMain` compares real
// paths: on 11-26 every agent's first Area review run wrote nothing and failed with "no valid JSON in OUTPUT_FILE".
if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: {
    agent: { type: "string" }, db: { type: "string" }, "agents-dir": { type: "string" }, ledger: { type: "string" }, server: { type: "string" }, box: { type: "string" },
  } });
  if (!values.agent) throw new Error("--agent <agent id> names the agent whose area this reviews");
  const result = await runAreaReview({ agent: values.agent, db: values.db, agentsDir: values["agents-dir"], ledger: values.ledger, server: values.server, box: values.box });
  const json = JSON.stringify(result, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

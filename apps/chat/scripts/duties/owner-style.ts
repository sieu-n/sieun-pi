/**
 * Duty precheck: owner style reaches every agent (owner's words, #sw-factory-build, 11-20: p97 "이런거 말할떄는 가장 흥미로운거 하나는 제대로
 * 설명해야지^^", then p107 under it "at a meta level will these messages be conveyed to you and be fixed ?").
 * A correction of how agents write or behave holds for every agent, so it must reach the shared text every agent loads: the sw-factory skill
 * (skills/sw-factory/SKILL.md) and the comm role text pi-host renders (packages/pi-host/src/durable/agent-profile.ts). One agent's memory
 * reaches only that agent. `~/work/owner-style/notes.json` lists each style note with the owner's words, the posts it came from, the words
 * the shared text must hold and the blind check that shows a fresh agent follows it; `not_style` lists owner posts that looked like style
 * feedback and are not.
 *
 * Metrics:
 *   style_notes_shared_pct, the headline: of the owner style notes of the last day, the share whose words the live skill or the live role
 *     text holds. A candidate post of the last day that neither list names counts as a note that is not shared yet.
 *   blind_follow_pct: of the notes of the last 7 days with a blind set, the share whose blind run passes; each run is a fresh `test: true`
 *     agent in a fresh channel (apps/chat/scripts/blind-replies.mjs --set <set>), archived after.
 *   shared_all_pct: of every listed note, the share the shared text still holds, so a later edit that drops one shows.
 *   unsorted_candidates: owner posts of the last day in real rooms that read like style feedback and that neither list names.
 *
 * A candidate is an owner post in a room that is not a test or archived room, whose text matches STYLE_WORDS. A note's `match` words use
 * agent-memory.ts `holds`: all of them, each form "a|b" taking either.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/owner-style.ts [--no-blind] [--notes <file>] [--skill <file>] [--profile <file>]
 *   [--data-dir <dir>] [--server http://127.0.0.1:5184] [--runs <dir>]
 * Defaults: ~/work/owner-style/notes.json, ~/.prime/agent/skills/sw-factory/SKILL.md (what agents load), the live pi-host release's
 * agent-profile.ts, APPS_CHAT_DATA_DIR else ~/.pi/agent/chat, APPS_CHAT_URL else http://127.0.0.1:5184, ~/work/owner-style/runs.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { holds } from "./agent-memory.ts";

const DAY_MS = 86_400_000;
/** How far back a note's blind check reruns each day; 7 days of notes was 4 sets on 11-20. */
const BLIND_DAYS = 7;

export interface Note {
  id: string;
  /** The owner's posts it came from, as `<room>/<post>`. */
  posts: string[];
  at: string;
  words: string;
  rule: string;
  /** Words the skill holds for it, and words the rendered role text holds for it. */
  skill?: string[];
  role?: string[];
  /** The blind-replies.mjs set that checks it, or the reason it has none. */
  blind?: { set: string } | { none: string };
  /** The job that owns its text, when another job does. */
  owner?: string;
}
export interface NotesFile { notes: Note[]; not_style?: { post: string; why: string }[] }
export interface Post { room: string; id: string; at: number; text: string }

/**
 * Words of the owner's posts that correct how agents write, from his 11-20 posts in #sw-factory-build (p62, p75, p97, p101, p104, p106) and
 * #dev-search-general (p14). It finds candidates for a person to sort, so it errs toward too many.
 */
export const STYLE_WORDS = new RegExp([
  "답변", "말할\\s*[때떄]", "설명(해|하)", "대답", "이런거", "슬롭", "\\bslop", "\\bshape\\b", "\\bformat", "\\btone\\b", "\\bbullet", "check ?mark", "체크",
  "\\bemoji", "이모지", "눈까리", "\\btable\\b", "\\bheadings?\\b", "\\bbold\\b", "\\bverbose\\b", "too long", "too short", "\\bwordy\\b",
  "like (a )?slack", "is slack", "not chat", "when (you )?(reply|answer|list|explain|post)", "response",
].join("|"), "i");

/** The owner's posts in real rooms since `since`: rooms that are not test or archived. */
export function ownerPosts(dataDir: string, since: number): Post[] {
  const rooms = (JSON.parse(readFileSync(join(dataDir, "rooms.json"), "utf8")) as { rooms: { id: string; test?: boolean; archived?: boolean }[] }).rooms;
  const posts: Post[] = [];
  for (const room of rooms) {
    if (room.test || room.archived) continue;
    const file = join(dataDir, "rooms", `${room.id}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: { t?: string; post?: { id?: string; author?: string; at?: number; text?: string } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const post = entry.post;
      if (entry.t !== "post" || post?.author !== "owner" || !post.id || (post.at ?? 0) < since) continue;
      posts.push({ room: room.id, id: post.id, at: post.at!, text: post.text ?? "" });
    }
  }
  return posts;
}

/** Whether the shared text holds a note: the skill holds its skill words, or the role text its role words. */
export function shared(note: Note, skill: string, role: string): { skill: boolean; role: boolean } {
  return { skill: !!note.skill?.length && holds(skill, note.skill), role: !!note.role?.length && holds(role, note.role) };
}

/** The role text every comm and work thread gets from the live pi-host release, for an ordinary agent and for agent factory, in a DM and a channel. */
export async function roleText(profile: string): Promise<string> {
  const mod = await import(profile) as { commInstructions: (ref: { agent: string; room: string; work: string }) => string; workInstructions: (ref: { agent: string; comm: string }) => string };
  return [
    mod.commInstructions({ agent: "ag_style-check", room: "dm_style-check", work: "w" }),
    mod.commInstructions({ agent: "ag_style-check", room: "ch_1a2b3c4d", work: "w" }),
    mod.commInstructions({ agent: "ag_agent-factory", room: "ch_1a2b3c4d", work: "w" }),
    mod.workInstructions({ agent: "ag_agent-factory", comm: "c" }),
  ].join("\n");
}

const pct = (part: number, whole: number): number => (whole ? Math.round((1000 * part) / whole) / 10 : 100);

/** One blind-replies.mjs run of a set; answers its summary line, or an error when the run printed none. */
function blindRun(script: string, set: string, out: string, server: string): Promise<{ pass: boolean; passed?: number; of?: number; room?: string; agent?: string; error?: string }> {
  return new Promise(done => {
    const child = spawn(process.execPath, [script, "--set", set, "--out", out, "--server", server], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", chunk => { err = (err + String(chunk)).slice(-400); });
    child.on("close", () => {
      const last = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").at(-1) : undefined;
      const summary = last ? JSON.parse(last) as { pass?: boolean; passed?: number; of?: number; room?: string; agent?: string; ask?: string } : undefined;
      if (!summary || summary.ask !== undefined) done({ pass: false, error: err.trim() || "the run wrote no summary" });
      else done({ pass: !!summary.pass, passed: summary.passed, of: summary.of, room: summary.room, agent: summary.agent });
    });
  });
}

/** Archives a blind run's test agent through its thread, so the daily runs leave no open agent. */
async function archiveAgent(server: string, id: string): Promise<void> {
  const agents = await fetch(`${server}/api/agents?test=1`).then(r => r.json()) as { id: string; thread: string }[];
  const thread = agents.find(agent => agent.id === id)?.thread;
  if (thread) await fetch(`${server}/api/c/${thread}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    notes: { type: "string" }, skill: { type: "string" }, profile: { type: "string" }, "data-dir": { type: "string" }, server: { type: "string" },
    runs: { type: "string" }, "no-blind": { type: "boolean" },
  } });
  const notesFile = resolve(values.notes ?? join(homedir(), "work/owner-style/notes.json"));
  const skillFile = resolve(values.skill ?? join(homedir(), ".prime/agent/skills/sw-factory/SKILL.md"));
  const profile = resolve(values.profile ?? join(homedir(), ".local/share/pi-host/current/packages/pi-host/src/durable/agent-profile.ts"));
  const dataDir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const now = Date.now();
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const runs = resolve(values.runs ?? join(homedir(), "work/owner-style/runs"), stamp);

  const file = JSON.parse(readFileSync(notesFile, "utf8")) as NotesFile;
  const skill = readFileSync(skillFile, "utf8");
  const role = await roleText(profile);
  const flagged: { kind: string; excerpt: string; sig: string }[] = [];

  const named = new Set([...file.notes.flatMap(note => note.posts), ...(file.not_style ?? []).map(item => item.post)]);
  const candidates = ownerPosts(dataDir, now - DAY_MS).filter(post => STYLE_WORDS.test(post.text));
  const unsorted = candidates.filter(post => !named.has(`${post.room}/${post.id}`));
  for (const post of unsorted) {
    flagged.push({ kind: "unsorted_candidate", excerpt: `${post.room}/${post.id} ${new Date(post.at).toISOString().slice(5, 16)}: ${post.text.replace(/\s+/g, " ").slice(0, 200)}`, sig: `cand:${post.room}/${post.id}` });
  }

  const rows = file.notes.map(note => ({ note, held: shared(note, skill, role), recent: Date.parse(note.at) >= now - DAY_MS }));
  for (const { note, held } of rows) {
    if (held.skill || held.role) continue;
    flagged.push({ kind: "not_shared", excerpt: `${note.id} (${note.posts.join(", ")}${note.owner ? `, text owned by ${note.owner}` : ""}): ${note.rule.slice(0, 160)}`, sig: `shared:${note.id}` });
  }
  const recent = rows.filter(row => row.recent);
  const recentShared = recent.filter(row => row.held.skill || row.held.role).length;

  const blindRows: Record<string, unknown>[] = [];
  let blindPassed = 0;
  const blindDue = file.notes.filter(note => note.blind && "set" in note.blind && Date.parse(note.at) >= now - BLIND_DAYS * DAY_MS);
  if (!values["no-blind"] && blindDue.length) {
    mkdirSync(runs, { recursive: true });
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "blind-replies.mjs");
    await Promise.all(blindDue.map(async note => {
      const set = (note.blind as { set: string }).set;
      const out = join(runs, `${note.id}-${set}.jsonl`);
      const result = await blindRun(script, set, out, server);
      if (result.agent) await archiveAgent(server, result.agent).catch(() => undefined);
      blindRows.push({ note: note.id, set, out, ...result });
      if (result.pass) blindPassed++;
      else flagged.push({ kind: result.error ? "blind_error" : "blind_failed", excerpt: `${note.id} --set ${set}: ${result.error ?? `${result.passed} of ${result.of} asks pass`}; replies in ${out}`, sig: `blind:${note.id}` });
    }));
  }

  const metrics: Record<string, number> = {
    style_notes_shared_pct: pct(recentShared, recent.length + unsorted.length),
    shared_all_pct: pct(rows.filter(row => row.held.skill || row.held.role).length, rows.length),
    unsorted_candidates: unsorted.length,
    notes_last_day: recent.length,
    notes_all: rows.length,
    candidates_last_day: candidates.length,
  };
  if (!values["no-blind"]) {
    metrics.blind_follow_pct = pct(blindPassed, blindDue.length);
    metrics.blind_runs = blindDue.length;
  }
  const output = {
    metrics,
    flagged: [{ kind: "summary", excerpt: `${recentShared} of ${recent.length + unsorted.length} style notes of the last day are in the shared text (${unsorted.length} unsorted); ` +
      `${rows.filter(row => row.held.skill || row.held.role).length} of ${rows.length} notes in all; ` +
      `${values["no-blind"] ? "no blind run" : `${blindPassed} of ${blindDue.length} blind runs pass`}`, sig: "summary" }, ...flagged],
    notesFile, skillFile, profile,
    notes: rows.map(({ note, held, recent }) => ({ id: note.id, posts: note.posts, recent, skill: held.skill, role: held.role, ...(note.owner ? { owner: note.owner } : {}) })),
    blind: blindRows,
  };
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

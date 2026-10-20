import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { loadSkillsFromDir } from "prime-agent";
import { CorrectionLedger, repeatsBetween, type ChatHistory } from "../../src/chat-corrections.ts";
import { chatHistory, fileChatHistory } from "../../src/owner-history.ts";
import { readAppended } from "./read-appended.ts";
import { firstFixLanded, fixRepos, gitCommitTime, sideLabel, splitLastEvents, splitMetrics, splitRepeats } from "./repeat-split.ts";
import { grafanaPrometheus } from "../../src/usage/lgtm.ts";
import { measureCache, NO_DATA, WINDOWS, type CacheMetric } from "./cache-ratio.ts";
import { SMOKE_SESSION, smokeSkills, type SmokeEnv } from "./skill-smoke.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Skills and harness duty's precheck (`node --import tsx scripts/duties/harness-health.ts`): outcomes, never sizes. The owner asked to "prune
 * bloated skills every day" and said word and line counts mean nothing to watch (10-10, c39), and asked that the hourly and daily cache read share
 * stay high (10-10, c41). The headline, skills_to_prune, counts the skills a daily prune should act on: each skill that fails its smoke check
 * (skill-smoke.ts) or that no agent read in 14 days, and each skill pair whose descriptions overlap and neither of which is already counted. The
 * output also keeps the three parts and the owner corrections given again in 7 days, though the duty judges those in Chat system. No model
 * call; the wiki database and the transcripts are read only, and the smoke's repo skill reads carry SMOKE_SESSION so they never count as a read.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
export const UNREAD_DAYS = 14;
export const REPEAT_DAYS = 7;
/** At 0.2 the 10-10 run caught claude-in-codex and codex-in-claude (0.26, merged); the 10-13 pair stack/python and frontend-implementation (0.20) was a false hit. */
export const OVERLAP_MIN = 0.2;
/** Pairs this close are listed for the job to judge, though only pairs at OVERLAP_MIN count in the metric. */
export const OVERLAP_LIST = 0.1;
const EXCERPT_MAX = 500;
export const AUTO_SNS = process.env.HARNESS_REPO || join(homedir(), "Documents/Github/auto-sns-agent");

/**
 * Where skills live. `views` is the path prefix the llm-wiki view events use for this root. `transcripts` marks a root whose skills sit one
 * level down and are read straight from disk, so a read is a Prime Agent tool call that names a file in the skill or calls its Python module,
 * or a `/skill:<name>` load (transcriptReads). A root with neither has no read tracking.
 * `repo` is the repo whose `scripts/skills/read-skill.mjs` reads this root's skills; the smoke check runs it for each one.
 */
export interface SkillRoot { name: string; dir: string; views?: string; transcripts?: true; repo?: string }
export interface Skill {
  id: string; root: string; dir: string; description: string;
  /** The module name of a Python skill, which agents call as `<importName>.<function>(...)`. */
  importName?: string;
  /** The newest view event for any file in the skill, or null when it has read tracking and no view; undefined when it has no tracking. */
  lastRead?: string | null;
}
/** One llm-wiki view event: the file path and its time. */
export interface View { path: string; ts: string }
/** One skill's smoke check result. */
export interface SkillSmoke { skill: string; pass: boolean; detail?: string }
export interface HarnessDeps {
  roots: readonly SkillRoot[]; views: (since: string) => Promise<View[]>; dataDir: string; now: number;
  /** The cache read shares from LGTM (`measureCache`) against the duty's targets. */
  cache: () => Promise<{ metrics: Record<CacheMetric, number>; flagged: FlaggedSlice[] }>;
  /** A chat's owner words and `/refine` commands, for the repeats the owner gave (`repeatsBetween`). */
  history: (chat: string) => Promise<ChatHistory>;
  /** When a commit a correction's ref names landed (`splitRepeats`), undefined for one no repo knows. */
  commitTime: (hash: string) => Promise<number | undefined>;
  /** The Prime Agent transcript files that changed since the given time, for the reads of `transcripts` roots. */
  transcripts: (since: number) => Promise<string[]>;
  smoke: SmokeEnv;
}

/** The `description` in a SKILL.md's frontmatter: one line, quoted or not, or a folded `>` / `|` block. */
export function description(markdown: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const rows = front.split("\n");
  const at = rows.findIndex(row => /^description:/.test(row));
  if (at < 0) return "";
  const first = rows[at]!.slice("description:".length).trim();
  if (first && !/^[>|][-+]?$/.test(first)) return first.replace(/^(["'])([\s\S]*)\1$/, "$2");
  const block: string[] = [];
  for (const row of rows.slice(at + 1)) { if (!/^\s/.test(row)) break; block.push(row.trim()); }
  return block.join(" ").trim();
}

/** Every skill directory under a root: a directory with a SKILL.md, found through symlinks, not looked into further. */
async function skillDirs(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  if (await stat(join(dir, "SKILL.md")).then(info => info.isFile(), () => false)) return [dir];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    found.push(...await skillDirs(join(dir, entry.name), depth + 1));
  }
  return found;
}

/** Every skill under the roots, each real directory once (an installed symlink and its source are one skill), sorted by id. */
export async function readSkills(roots: readonly SkillRoot[]): Promise<Skill[]> {
  const seen = new Set<string>();
  const skills: Skill[] = [];
  for (const root of roots) {
    for (const dir of await skillDirs(root.dir)) {
      const real = await realpath(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      const prime = loadSkillsFromDir({ dir, source: "path" }).skills[0];
      const importName = prime?.kind === "python" ? prime.python.importName : undefined;
      skills.push({ id: `${root.name}:${relative(root.dir, dir)}`, root: root.name, dir: real, description: description(await readFile(join(dir, "SKILL.md"), "utf8")),
        ...(importName ? { importName } : {}) });
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

const STOP = new Set(("when use used using with from into that this these those your their them they what which while where only also each every any " +
  "for the and not are was but its it's all can has have had via per own one two more most than then such other any about after before over under " +
  "skill skills owns covers work working changing change changes adding add repo agent agents").split(" "));
const tokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(word => !STOP.has(word)));

/** Pairs of skills whose descriptions share the most words (Jaccard over content words), most overlap first. */
export function overlaps(skills: readonly Skill[], min = OVERLAP_MIN): { a: string; b: string; score: number; shared: string[] }[] {
  const sets = skills.map(skill => ({ id: skill.id, words: tokens(skill.description) }));
  const pairs: { a: string; b: string; score: number; shared: string[] }[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!, b = sets[j]!;
      if (!a.words.size || !b.words.size) continue;
      const shared = [...a.words].filter(word => b.words.has(word));
      const score = shared.length / (a.words.size + b.words.size - shared.length);
      if (score >= min) pairs.push({ a: a.id, b: b.id, score: Math.round(score * 100) / 100, shared });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isRecord(value) ? Object.values(value).flatMap(strings) : [];

/** What transcriptReads keeps between runs: the bytes of each transcript already read and the newest read of each skill. */
export interface ReadState { version: number; offsets: Record<string, number>; reads: Record<string, string> }
/** Bump when the read rules change, so the next run reads every transcript again. */
export const READS_VERSION = 1;
export const READS_FILE = "harness-skill-reads.json";

/**
 * The reads of `transcripts` root skills in Prime Agent transcripts since `since`, as view events with the path `<skill id>/`: an assistant tool
 * call whose arguments name `skills/<name>/...` (a SKILL.md, a reference, a script) or call `<importName>.<function>(`, and a user message that
 * loads `<skill name="<name>"` (Prime's `/skill:<name>`). A path in a brief or a tool result is no read.
 * It reads each file from the offset `state` holds and moves the offsets and reads forward, because 14 days of transcripts were 8 GB on
 * 10-15 and a full read took 44 s, while a day's appended bytes are about a seventh of that.
 */
export async function transcriptReads(files: readonly string[], skills: readonly Skill[], roots: readonly SkillRoot[], since: number, state: ReadState): Promise<View[]> {
  const tracked = skills.filter(skill => roots.some(root => root.transcripts && root.name === skill.root));
  if (!tracked.length) return [];
  const byName = new Map(tracked.map(skill => [skill.id.slice(skill.root.length + 1), skill.id]));
  const byImport = new Map(tracked.filter(skill => skill.importName).map(skill => [skill.importName!, skill.id]));
  const path = new RegExp(`skills/(${[...byName.keys()].map(escape).join("|")})(?![\\w-])`, "g");
  const call = byImport.size ? new RegExp(`(?<![\\w.])(${[...byImport.keys()].map(escape).join("|")})\\.\\w+\\(`, "g") : null;
  const read = (id: string | undefined, ts: string) => { if (id && ts > (state.reads[id] ?? "")) state.reads[id] = ts; };
  const needles = ["skills/", "<skill name=", ...[...byImport.keys()].map(name => `${name}.`)].map(text => ({ text }));
  const offsets: Record<string, number> = {};
  for (const file of files) {
    const { offset } = await readAppended(file, state.offsets[file] ?? 0, needles, line => {
      const head = line.slice(0, 400);
      if (!head.includes('"role":"assistant"') && !head.includes('"role":"user"')) return;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { return; }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || typeof entry.timestamp !== "string") return;
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at < since) return;
      const ts = new Date(at).toISOString();
      const { role, content } = entry.message;
      if (!Array.isArray(content)) return;
      if (role === "assistant") {
        for (const block of content) {
          if (!isRecord(block) || block.type !== "toolCall") continue;
          const args = strings(block.arguments).join("\n");
          for (const match of args.matchAll(path)) read(byName.get(match[1]!), ts);
          if (call) for (const match of args.matchAll(call)) read(byImport.get(match[1]!), ts);
        }
      } else if (role === "user") {
        for (const block of content) {
          if (isRecord(block) && typeof block.text === "string") for (const match of block.text.matchAll(/<skill name="([^"]+)"/g)) read(byName.get(match[1]!), ts);
        }
      }
    });
    offsets[file] = offset;
  }
  state.offsets = offsets;
  const sinceIso = new Date(since).toISOString();
  for (const [id, ts] of Object.entries(state.reads)) if (ts < sinceIso) delete state.reads[id];
  return Object.entries(state.reads).map(([id, ts]) => ({ path: `${id}/`, ts }));
}

/**
 * Sets each tracked skill's `lastRead`: for a `views` root the newest view event whose path is under the skill's directory in that root, and
 * for a `transcripts` root the newest transcript read (transcriptReads). A skill in a root with neither keeps `lastRead` undefined.
 */
export function markReads(skills: Skill[], roots: readonly SkillRoot[], views: readonly View[]): void {
  const newest = new Map<string, string>();
  for (const view of views) if (view.ts > (newest.get(view.path) ?? "")) newest.set(view.path, view.ts);
  for (const skill of skills) {
    const root = roots.find(candidate => candidate.name === skill.root);
    if (root?.transcripts) { skill.lastRead = newest.get(`${skill.id}/`) ?? null; continue; }
    if (!root?.views) continue;
    const prefix = `${root.views}${skill.id.slice(root.name.length + 1)}/`;
    let last: string | null = null;
    for (const [path, ts] of newest) if (path.startsWith(prefix) && (!last || ts > last)) last = ts;
    skill.lastRead = last;
  }
}

export async function measureHarness(deps: HarnessDeps): Promise<PrecheckOutput & { skills: Skill[]; smoke: SkillSmoke[] }> {
  const skills = await readSkills(deps.roots);
  const sinceMs = deps.now - UNREAD_DAYS * DAY;
  const since = new Date(sinceMs).toISOString();
  let reads: View[] = [];
  if (deps.roots.some(root => root.transcripts)) {
    const file = join(deps.dataDir, READS_FILE);
    const saved = await readFile(file, "utf8").then(text => JSON.parse(text) as ReadState, () => null);
    const state: ReadState = saved?.version === READS_VERSION ? saved : { version: READS_VERSION, offsets: {}, reads: {} };
    reads = await transcriptReads(await deps.transcripts(sinceMs), skills, deps.roots, sinceMs, state);
    await writeFile(file, JSON.stringify(state) + "\n");
  }
  markReads(skills, deps.roots, [...await deps.views(since), ...reads]);
  const listed = overlaps(skills, OVERLAP_LIST);
  const pairs = listed.filter(pair => pair.score >= OVERLAP_MIN);
  const unread = skills.filter(skill => skill.lastRead === null);
  const repeats = await splitRepeats(await repeatsBetween(await new CorrectionLedger(deps.dataDir).read(), deps.now - REPEAT_DAYS * DAY, deps.now, deps.history,
    entry => firstFixLanded(entry.ref, Date.parse(entry.at), deps.now, deps.commitTime)), deps.now, deps.commitTime);
  const smoke = await smokeSkills(skills, deps.roots, deps.smoke);
  const failures = smoke.filter(result => !result.pass);
  const flagged: FlaggedSlice[] = [
    ...failures.map(result => ({ kind: "skill_smoke_failures", excerpt: `${result.skill} failed its smoke check${result.detail ? `: ${result.detail}` : ""}` })),
    ...repeats.map(item => ({ chat: item.repeat.chat.id, at: item.said, kind: "repeat_corrections_7d",
      excerpt: `${sideLabel(item)}: ${item.entry.id} "${item.entry.rule}" (enforced by ${item.entry.enforcedBy}: ${item.entry.ref}) given again in ${item.repeat.chat.name || item.repeat.chat.id}: ${item.repeat.words}`.slice(0, EXCERPT_MAX) })),
    ...unread.map(skill => ({ kind: "unread_14d", excerpt: `${skill.id} (${skill.dir}) has no ${deps.roots.find(root => root.name === skill.root)?.transcripts ? "agent read in a Prime transcript" : "view event"} since ${since.slice(0, 10)}` })),
    ...listed.slice(0, 8).map(pair => ({ kind: "overlap", excerpt: `${pair.a} and ${pair.b} share ${Math.round(pair.score * 100)}% of description words: ${pair.shared.slice(0, 12).join(", ")}` })),
  ];
  // An LGTM failure is no data: both shares read NO_DATA, a miss, and the skill checks still report.
  const cache = await deps.cache().catch((error: unknown) => ({ metrics: Object.fromEntries(Object.keys(WINDOWS).map(key => [key, NO_DATA])),
    flagged: [{ kind: "cache_error", excerpt: `no data: the cache read shares could not be read from LGTM: ${error instanceof Error ? error.message : String(error)}` }] }));
  const untracked = skills.filter(skill => skill.lastRead === undefined).length;
  if (untracked) flagged.push({ kind: "untracked", excerpt: `${untracked} skills have no read tracking (no llm-wiki view events for their root), so unread_14d leaves them out` });
  const prune = new Set([...failures.map(result => result.skill), ...unread.map(skill => skill.id)]);
  const skillsToPrune = prune.size + pairs.filter(pair => !prune.has(pair.a) && !prune.has(pair.b)).length;
  return {
    metrics: { skills_to_prune: skillsToPrune, skill_smoke_failures: failures.length, unread_14d: unread.length, overlapping_pairs: pairs.length, ...cache.metrics,
      repeat_corrections_7d: repeats.length, ...splitMetrics(repeats) },
    lastEventAt: splitLastEvents(repeats, deps.now),
    flagged: [...cache.flagged, ...flagged.slice(0, 40)],
    skills,
    smoke,
  };
}

/**
 * The files under `dir` that `accepts` takes. In session-artifacts it enters only `sub-*` folders below the first level: transcripts sit in
 * session folders and their RLM child chains (`primeRoots`), and agents keep millions of artifact files beside them.
 */
async function transcripts(dir: string, accepts: (path: string) => boolean, subOnly: boolean, depth = 0): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && (!subOnly || depth === 0 || entry.name.startsWith("sub-"))) found.push(...await transcripts(path, accepts, subOnly, depth + 1));
    else if (entry.isFile() && accepts(path)) found.push(path);
  }
  return found;
}

const jsonl = (path: string) => path.endsWith(".jsonl");
/**
 * Where Prime Agent transcripts sit: root sessions flat in sessions/, root sessions moved to sessions-archive/, and RLM children under
 * session-artifacts/<root id>/sub-<id>/[sub-<id>/...]<session>.jsonl (never rlm-subagents.jsonl).
 */
export function primeRoots(home: string): { root: string; accepts(path: string): boolean }[] {
  const prime = join(home, ".prime", "agent");
  const sessions = join(prime, "sessions"), artifacts = join(prime, "session-artifacts");
  return [
    { root: sessions, accepts: path => jsonl(path) && !relative(sessions, path).includes(sep) },
    { root: join(prime, "sessions-archive"), accepts: jsonl },
    { root: artifacts, accepts: path => {
      if (!jsonl(path)) return false;
      const parts = relative(artifacts, path).split(sep);
      return parts.length >= 3 && parts.slice(1, -1).every(part => part.startsWith("sub-")) && parts.at(-1) !== "rlm-subagents.jsonl";
    } },
  ];
}

/** Every Prime Agent transcript that changed since `since`. */
export async function primeTranscripts(home: string, since: number): Promise<string[]> {
  const found: string[] = [];
  for (const root of primeRoots(home)) {
    for (const path of await transcripts(root.root, root.accepts, basename(root.root) === "session-artifacts")) {
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs >= since) found.push(path);
    }
  }
  return found;
}

const MAC = process.env.MAC_SSH_HOST || "mac";
/** The ssh read of one Mac chat. On 10-20 at 01:00Z frontend bro's 9.6 MB of owner and refine lines took 54 s plain and 3.5 s gzipped. */
const MAC_READ_S = 120;
/** The owner and `/refine` lines of a Mac session file, gzipped on the Mac, as one buffer; empty when the Mac has no such file. */
export function macSessionLines(chat: string): Promise<Buffer> {
  if (!/^[0-9a-f-]+$/.test(chat)) return Promise.reject(new Error(`not a session id: ${chat}`));
  const command = `f="$HOME/.prime/agent/sessions/${chat}.jsonl"; [ -f "$f" ] && grep -h -F -e '"role":"user"' -e '"session_slash_command"' "$f" | gzip -c; true`;
  return new Promise((resolve, reject) => execFile("timeout", [String(MAC_READ_S), "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", MAC, command],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`ssh ${MAC}: ${(stderr.toString() || error.message).trim().slice(0, 300)}`)) : resolve(stdout)));
}

/**
 * A chat's history for the repeat count: its session file in `dir`, or, when this box has no such file, the Mac's copy (`mac`), since chats
 * that never moved to the box live only there. On 10-19 9 of the 21 repeats in the window came from frontend bro and mac-management, which
 * live only on the Mac, and the box's precheck dropped them as words the owner never wrote. A failed Mac read goes into `errors` and reads as
 * no history.
 */
export function chatHistories(dir: string, mac: ((chat: string) => Promise<Buffer>) | null, errors: string[]): (chat: string) => Promise<ChatHistory> {
  return async chat => {
    const file = join(dir, `${chat}.jsonl`);
    if (!mac || await stat(file).then(() => true, () => false)) return fileChatHistory(file);
    try {
      const packed = await mac(chat);
      return chatHistory(packed.length ? gunzipSync(packed).toString("utf8").split("\n") : []);
    } catch (error) {
      errors.push(`${chat}: ${error instanceof Error ? error.message : String(error)}`);
      return { owner: [], refines: [] };
    }
  };
}

/** The view events since `since` for files under .agents/skills or .claude/skills-native, from the wiki database, opened read only, without the smoke's reads. */
async function wikiViews(db: string, since: string): Promise<View[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(db, { readOnly: true });
  try {
    return database.prepare("SELECT path, max(ts) AS ts FROM views WHERE ts >= ? AND (path LIKE '@code/.agents/skills/%' OR path LIKE '@code/.claude/skills-native/%') AND coalesce(session_id, '') != ? GROUP BY path")
      .all(since, SMOKE_SESSION) as unknown as View[];
  } finally { database.close(); }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("harness-health: OUTPUT_FILE is not set\n"); process.exit(2); }
  const roots: SkillRoot[] = [
    { name: "repo", dir: join(AUTO_SNS, ".agents/skills"), views: "@code/.agents/skills/", repo: AUTO_SNS },
    { name: "native", dir: join(AUTO_SNS, ".claude/skills-native"), views: "@code/.claude/skills-native/", repo: AUTO_SNS },
    { name: "prime", dir: join(homedir(), ".prime/agent/skills"), transcripts: true },
  ];
  const db = join(AUTO_SNS, "apps/llm-wiki/content/.wiki/wiki.db");
  const dataDir = process.env.HARNESS_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
  // The cache targets live in the Skills and tools duty since Skills and harness merged into it on 10-16.
  const duty = JSON.parse(await readFile(join(import.meta.dirname, "skills-and-tools.duty.json"), "utf8")) as { metrics: { key: string; target: number }[] };
  const cacheTargets = Object.fromEntries(Object.keys(WINDOWS).map(key => [key, duty.metrics.find(metric => metric.key === key)!.target])) as Record<CacheMetric, number>;
  const python = join(process.env.PRIME_AGENT_KERNEL_VENV || join(homedir(), ".prime/agent/kernel-venv"), "bin/python");
  const cache = () => measureCache(grafanaPrometheus(join(dataDir, "grafana-alerts.json")), cacheTargets);
  const macErrors: string[] = [];
  const history = chatHistories(join(homedir(), ".prime/agent/sessions"), process.platform === "darwin" ? null : macSessionLines, macErrors);
  const { skills, smoke, ...result } = await measureHarness({ roots, views: since => wikiViews(db, since), dataDir, now: Date.now(), cache,
    history, commitTime: gitCommitTime(fixRepos(AUTO_SNS)), transcripts: since => primeTranscripts(homedir(), since), smoke: { python } });
  for (const error of macErrors) result.flagged = [...result.flagged ?? [], { kind: "repeat_corrections_mac", excerpt: `no data: the Mac read of a chat's session failed, so its repeats are left out: ${error}`.slice(0, EXCERPT_MAX) }];
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (process.env.DETAILS_FILE) await writeFile(process.env.DETAILS_FILE, JSON.stringify({ skills: skills.map(({ description: _, ...skill }) => skill), smoke }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

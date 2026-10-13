import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { CorrectionLedger, repeatsBetween } from "../../src/chat-corrections.ts";
import { fileOwnerTexts } from "../../src/owner-history.ts";
import { missing } from "../../src/locked-json.ts";
import { measureCache, readSessions, WINDOWS, type CacheMetric, type SessionCalls } from "./cache-ratio.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Skills and harness duty's precheck (`node --import tsx scripts/duties/harness-health.ts`): outcomes, never sizes. The owner (10-10, c39)
 * said word and line counts of skills and SKILL.md files mean nothing to watch. It counts skill smoke checks that fail, owner
 * corrections given again in 7 days, skills no agent read in 14 days, skill pairs whose descriptions overlap, and the prompt cache read share
 * of the last hour and day (cache-ratio.ts). No model call; the wiki database and the transcripts are read only.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
export const UNREAD_DAYS = 14;
export const REPEAT_DAYS = 7;
export const OVERLAP_MIN = 0.2;
/** Pairs this close are listed for the job to judge, though only pairs at OVERLAP_MIN count in the metric. */
export const OVERLAP_LIST = 0.1;
const EXCERPT_MAX = 500;
/** The results file a skill smoke duty writes in the data dir: `{ results: [{ skill, pass, detail? }] }`. */
export const SKILL_SMOKE_FILE = "skill-smoke.json";
const AUTO_SNS = process.env.HARNESS_REPO || join(homedir(), "Documents/Github/auto-sns-agent");

/** Where skills live. `views` is the path prefix the llm-wiki view events use for this root; a root without one has no read tracking. */
export interface SkillRoot { name: string; dir: string; views?: string }
export interface Skill {
  id: string; root: string; dir: string; description: string;
  /** The newest view event for any file in the skill, or null when it has read tracking and no view; undefined when it has no tracking. */
  lastRead?: string | null;
}
/** One llm-wiki view event: the file path and its time. */
export interface View { path: string; ts: string }
/** One skill's smoke check result. */
export interface SkillSmoke { skill: string; pass: boolean; detail?: string }
export interface HarnessDeps {
  roots: readonly SkillRoot[]; views: (since: string) => Promise<View[]>; dataDir: string; now: number;
  /** Prime Agent transcripts with calls since the given time, and the duty's targets for the cache shares. */
  sessions: (since: number) => Promise<SessionCalls[]>; cacheTargets: Record<CacheMetric, number>;
  /** A chat's owner messages, for the repeats the owner gave (`repeatsBetween`). */
  ownerTexts: (chat: string) => Promise<readonly string[]>;
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
      skills.push({ id: `${root.name}:${relative(root.dir, dir)}`, root: root.name, dir: real, description: description(await readFile(join(dir, "SKILL.md"), "utf8")) });
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

/** Sets each tracked skill's `lastRead` from the view events: the newest event whose path is under the skill's directory in that root. */
export function markReads(skills: Skill[], roots: readonly SkillRoot[], views: readonly View[]): void {
  const newest = new Map<string, string>();
  for (const view of views) if (view.ts > (newest.get(view.path) ?? "")) newest.set(view.path, view.ts);
  for (const skill of skills) {
    const root = roots.find(candidate => candidate.name === skill.root);
    if (!root?.views) continue;
    const prefix = `${root.views}${skill.id.slice(root.name.length + 1)}/`;
    let last: string | null = null;
    for (const [path, ts] of newest) if (path.startsWith(prefix) && (!last || ts > last)) last = ts;
    skill.lastRead = last;
  }
}

/** The skill smoke results in the data dir, or null when no skill smoke duty has written them yet. Throws on a file that is not the shape. */
export async function readSkillSmoke(dataDir: string): Promise<SkillSmoke[] | null> {
  const path = join(dataDir, SKILL_SMOKE_FILE);
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
  const results = (JSON.parse(text) as { results?: unknown }).results;
  if (!Array.isArray(results) || !results.every(row => typeof row?.skill === "string" && typeof row.pass === "boolean")) {
    throw new Error(`${path}: expected { results: [{ skill, pass, detail? }] }`);
  }
  return results.map(({ skill, pass, detail }) => ({ skill, pass, ...(typeof detail === "string" ? { detail } : {}) }));
}

export async function measureHarness(deps: HarnessDeps): Promise<PrecheckOutput & { skills: Skill[] }> {
  const skills = await readSkills(deps.roots);
  const since = new Date(deps.now - UNREAD_DAYS * DAY).toISOString();
  markReads(skills, deps.roots, await deps.views(since));
  const listed = overlaps(skills, OVERLAP_LIST);
  const pairs = listed.filter(pair => pair.score >= OVERLAP_MIN);
  const unread = skills.filter(skill => skill.lastRead === null);
  const repeats = await repeatsBetween(await new CorrectionLedger(deps.dataDir).read(), deps.now - REPEAT_DAYS * DAY, deps.now, deps.ownerTexts);
  const smoke = await readSkillSmoke(deps.dataDir);
  const failures = smoke?.filter(result => !result.pass) ?? [];
  const flagged: FlaggedSlice[] = [
    ...failures.map(result => ({ kind: "skill_smoke_failures", excerpt: `${result.skill} failed its smoke check${result.detail ? `: ${result.detail}` : ""}` })),
    ...(smoke ? [] : [{ kind: "skill_smoke_failures", excerpt: `no ${join(deps.dataDir, SKILL_SMOKE_FILE)} yet: no skill smoke duty has run, so skill_smoke_failures is 0` }]),
    ...repeats.map(({ entry, repeat }) => ({ chat: repeat.chat.id, at: Date.parse(repeat.at), kind: "repeat_corrections_7d",
      excerpt: `${entry.id} "${entry.rule}" (enforced by ${entry.enforcedBy}: ${entry.ref}) given again in ${repeat.chat.name || repeat.chat.id}: ${repeat.words}`.slice(0, EXCERPT_MAX) })),
    ...unread.map(skill => ({ kind: "unread_14d", excerpt: `${skill.id} (${skill.dir}) has no view event since ${since.slice(0, 10)}` })),
    ...listed.slice(0, 8).map(pair => ({ kind: "overlap", excerpt: `${pair.a} and ${pair.b} share ${Math.round(pair.score * 100)}% of description words: ${pair.shared.slice(0, 12).join(", ")}` })),
  ];
  const cache = measureCache(await deps.sessions(deps.now - WINDOWS.cache_read_ratio_24h - HOUR), deps.now, deps.cacheTargets);
  const untracked = skills.filter(skill => skill.lastRead === undefined).length;
  if (untracked) flagged.push({ kind: "untracked", excerpt: `${untracked} skills have no read tracking (no llm-wiki view events for their root), so unread_14d leaves them out` });
  return {
    metrics: { skill_smoke_failures: failures.length, repeat_corrections_7d: repeats.length, unread_14d: unread.length, overlapping_pairs: pairs.length, ...cache.metrics },
    flagged: [...cache.flagged, ...flagged.slice(0, 40)],
    skills,
  };
}

/** The view events since `since` for files under .agents/skills or .claude/skills-native, from the wiki database, opened read only. */
async function wikiViews(db: string, since: string): Promise<View[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(db, { readOnly: true });
  try {
    return database.prepare("SELECT path, max(ts) AS ts FROM views WHERE ts >= ? AND (path LIKE '@code/.agents/skills/%' OR path LIKE '@code/.claude/skills-native/%') GROUP BY path")
      .all(since) as unknown as View[];
  } finally { database.close(); }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("harness-health: OUTPUT_FILE is not set\n"); process.exit(2); }
  const roots: SkillRoot[] = [
    { name: "repo", dir: join(AUTO_SNS, ".agents/skills"), views: "@code/.agents/skills/" },
    { name: "native", dir: join(AUTO_SNS, ".claude/skills-native"), views: "@code/.claude/skills-native/" },
    { name: "prime", dir: join(homedir(), ".prime/agent/skills") },
  ];
  const db = join(AUTO_SNS, "apps/llm-wiki/content/.wiki/wiki.db");
  const dataDir = process.env.HARNESS_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
  const duty = JSON.parse(await readFile(join(import.meta.dirname, "harness-health.duty.json"), "utf8")) as { metrics: { key: string; target: number }[] };
  const cacheTargets = Object.fromEntries(Object.keys(WINDOWS).map(key => [key, duty.metrics.find(metric => metric.key === key)!.target])) as Record<CacheMetric, number>;
  const { skills, ...result } = await measureHarness({ roots, views: since => wikiViews(db, since), dataDir, now: Date.now(), sessions: since => readSessions(homedir(), since), cacheTargets,
    ownerTexts: chat => fileOwnerTexts(join(homedir(), ".prime/agent/sessions", `${chat}.jsonl`)) });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (process.env.DETAILS_FILE) await writeFile(process.env.DETAILS_FILE, JSON.stringify(skills.map(({ description: _, ...skill }) => skill), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSettledStatus } from "../../../../../apps/wiki/scripts/read-cap.mjs";
import { wikiContentDir } from "../../src/chat-wiki.ts";
import { piCheckout } from "./wiki-dream.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Wiki and skill facts duty's precheck (`node --import tsx scripts/duties/wiki-skill-facts.ts`), for the knowledge manager's ask "make llm-wiki
 * info and, skills always up to date" (2026-11-20). It lists each curated wiki page (apps/, domains/, projects/), each repo skill (auto-sns-agent
 * `.agents/skills/**.md`) and each rule file (`.claude/rules/*.md`, root `CLAUDE.md` and `AGENTS.md`) that names a code fact which auto-sns-agent
 * commits took away after the doc's own date, and
 * each Prime agent skill whose source is in sieun-pi (`isPrimeSkillFile`) that names a code fact which sieun-pi commits took away after its own.
 * A fact is read from the doc's code spans: a repo path, a `file::name` definition, an env or constant name, a `pnpm <script>` and a `--flag`
 * of a script the span runs. A fact counts when it held at the doc's date and does not hold at HEAD, so a placeholder or an example that never
 * existed never counts. A page's date is its `updated` (or `last_verified`, the newer), a bare day read from 00:00 KST, and a skill's or rule
 * file's is the first-parent commit of its own repo that last touched it. Rule files count in `skills_with_stale_facts`, which keeps the duty at
 * its metric shape, and their own count is the part `skills_with_stale_facts_rules`. A sentence that says a thing was removed, renamed or replaced is history and is not read, and so are
 * experiment, incident and postmortem pages and the skills a vendor wrote (`vendorSkillDirs`).
 * The Wiki dream duty (wiki-dream.ts) already counts a page whose `<code>` path under apps, convex, packages, scripts or ops is missing, and every
 * `source_refs` change, so a page's path facts under those folders are left to it. A file that only changed counts in info `docs_with_changed_files`
 * and not in the headline: a changed file is a doc to reread, and its facts that broke are what the headline counts.
 * An input it cannot read counts in `source_errors` and writes 999999 for the headline, so the run reads error and says why.
 */

export const UNMEASURED = 999_999;
const KST_DAY_START = "T00:00:00+09:00";
/** The code paths the Wiki dream's stale check reads in a page's `<code>` spans (wiki-health.mjs CODE_REF). */
const DREAM_PREFIX = /^(?:apps|convex|packages|scripts|ops)\//;
/** A sentence that tells history, where an old name is the point (wiki-health.mjs REMOVAL, widened to renames and replacements). */
const HISTORY = /\b(?:removed|removal|deleted|no longer|renamed|retired|replaced|superseded|dropped|used to|formerly|was cut)\b/i;
const NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|ts|py|sh)$/;
const PNPM = /\bpnpm\s+(?:(?:-C|--dir|--filter|-F)\s+(\S+)\s+)?(?:run\s+)?([a-z][\w:.-]*)/g;

export type DocKind = "page" | "skill" | "rule" | "prime_skill";
export type Fact =
  | { kind: "path"; ref: string }
  | { kind: "symbol"; ref: string; file: string; name: string }
  | { kind: "name"; ref: string }
  | { kind: "script"; ref: string; dir: string; name: string }
  | { kind: "flag"; ref: string; file: string; flag: string };
export interface Doc { kind: DocKind; path: string; at: number; apps: string[]; facts: Fact[] }
export interface Drift { fact: Fact; detail: string }

/** Runs a program with no shell, feeding `input` on stdin, and gives its stdout as bytes; throws on a nonzero exit (rg and git grep exit 1 on no match, which gives ""). */
export type Run = (file: string, args: readonly string[], options: { cwd: string; input?: string; okCodes?: number[] }) => Promise<Buffer>;
export interface FactsDeps {
  run: Run;
  /** The auto-sns-agent checkout whose HEAD the pages' and repo skills' facts are judged at. */
  repo: string;
  /** The sieun-pi checkout whose HEAD the Prime skills' facts are judged at. */
  piRepo: string;
  /** The wiki content root; its apps/, domains/ and projects/ pages are read from disk, where the page API writes. */
  content: string;
  readText: (path: string) => Promise<string>;
  /** The curated page paths under `content`, relative to it. */
  listPages: () => Promise<string[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string, max = 240): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A page's `<!--wiki {json}-->` header, or {} when it has none or it does not parse. */
export function pageHeader(html: string): Record<string, unknown> {
  const match = /^<!--wiki\s*(\{[\s\S]*?\})\s*-->/.exec(html.slice(0, 8192));
  try { const value: unknown = match ? JSON.parse(match[1]!) : {}; return isRecord(value) ? value : {}; } catch { return {}; }
}

/** A header date in ms: a bare day reads from 00:00 KST, the owner's day; NaN when it does not parse. */
export function headerTime(value: unknown): number {
  if (typeof value !== "string" || !value) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + KST_DAY_START : value);
}

const unescape = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** A page's HTML as markdown-like text: `<pre>` blocks become fences, `<code>` spans backtick spans, every other tag goes. */
export function pageText(html: string): string {
  const fenced = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, body: string) => `\n\`\`\`\n${unescape(body.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`);
  const coded = fenced.replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, body: string) => `\`${unescape(body.replace(/<[^>]+>/g, "")).replace(/[`\n]/g, " ")}\``);
  return coded.split("```").map((part, index) => index % 2 ? part : unescape(part.replace(/<[^>]+>/g, " "))).join("```");
}

/**
 * The code spans of markdown text that a reader takes as current: each line of a fence, and each backtick span outside a history sentence.
 * With `history`, the backtick spans inside history sentences instead.
 */
export function codeSpans(text: string, history = false): string[] {
  const spans: string[] = [];
  text.split(/^```[^\n]*$/m).forEach((part, index) => {
    if (index % 2) { if (!history) spans.push(...part.split("\n").filter(line => line.trim())); return; }
    for (const sentence of part.split(/(?<=[.!?])\s+|\n\s*\n/)) {
      if (HISTORY.test(sentence.replace(/`[^`\n]*`/g, "")) !== history) continue;
      for (const match of sentence.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]!);
    }
  });
  return spans;
}

/** A span token as a concrete repo path, with its `::name` split off; null for a glob, placeholder, URL, flag, wiki page or bare word. */
export function pathToken(token: string): { path: string; name?: string } | null {
  const bare = token.replace(/^[("'[]+/, "").replace(/[)"',;.:\]]+$/, "");
  if (!bare.includes("/") || /[*{}<>$…]|\.\.\.|:\/\/|^[-~./]|^\/|@/.test(bare)) return null;
  const [path = "", name] = bare.split("::");
  const clean = path.replace(/:\d+(?:-\d+)?$/, "").replace(/#.*$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(clean) || clean.endsWith(".html") || clean.startsWith("apps/llm-wiki/content")) return null;
  return name && /^[\w$.]+$/.test(name) ? { path: clean, name } : { path: clean };
}

/**
 * The facts a doc's code spans name. `tops` are the top-level entries of HEAD's tree; a path whose first folder is not one of them counts only
 * when it resolves under one of the doc's app folders or its own folder (`candidates`), which the judge decides.
 */
export function readFacts(kind: DocKind, text: string): Fact[] {
  const markdown = kind === "page" ? pageText(text) : text;
  const told = factsOf(codeSpans(markdown, true));
  return [...factsOf(codeSpans(markdown))].filter(([key]) => !told.has(key)).map(([, fact]) => fact);
}

/**
 * The facts of code spans by `kind\x1fref`. readFacts drops a fact the doc also names in a history sentence, because the doc tells that name's
 * history: on 2026-11-21 .claude/rules/convex.md counted for `VIEW_READS = false` in a sentence telling what 2613785a3e set, while its next
 * sentence said S7b (01f9017846) deleted `VIEW_READS`.
 */
function factsOf(spans: readonly string[]): Map<string, Fact> {
  const facts = new Map<string, Fact>();
  const add = (fact: Fact): void => { const key = `${fact.kind}\x1f${fact.ref}`; if (!facts.has(key)) facts.set(key, fact); };
  for (const span of spans) {
    const tokens = span.split(/\s+/).filter(Boolean);
    let script: string | undefined;
    for (const token of tokens) {
      if (/^(?:\||;|&&|\|\||>|2>&1)$/.test(token)) { script = undefined; continue; }
      const path = pathToken(token);
      if (path) {
        add({ kind: "path", ref: path.path });
        if (path.name) add({ kind: "symbol", ref: `${path.path}::${path.name}`, file: path.path, name: path.name });
        script = SCRIPT_FILE.test(path.path) ? path.path : undefined;
        continue;
      }
      const flag = /^(--[a-z][\w-]*)(?:=.*)?$/.exec(token)?.[1];
      if (flag && script) { add({ kind: "flag", ref: `${script} ${flag}`, file: script, flag }); continue; }
      const name = /^([A-Z][A-Z0-9_]*)(?:=.*)?$/.exec(token.replace(/^[("'$]+|[)"',;.:]+$/g, ""))?.[1];
      if (name && NAME.test(name)) add({ kind: "name", ref: name });
    }
    for (const match of span.matchAll(PNPM)) {
      const where = match[1] ?? "";
      const dir = where.startsWith("apps/") || where.startsWith("packages/") ? where.replace(/\/+$/, "") : where && !where.includes("<") ? `apps/${where.replace(/^@[\w-]+\//, "")}` : "";
      if (where.includes("<")) continue;
      add({ kind: "script", ref: `pnpm ${where ? `${where} ` : ""}${match[2]}`, dir, name: match[2]! });
    }
  }
  return facts;
}

/** The apps a doc covers: a page's `apps` header, an app rule's or app skill's app name. */
export function docApps(kind: DocKind, path: string, header: Record<string, unknown> = {}): string[] {
  if (kind === "page") return Array.isArray(header.apps) ? header.apps.filter((app): app is string => typeof app === "string") : [];
  return [/^\.claude\/rules\/app-(.+)\.md$/.exec(path)?.[1], /^\.agents\/skills\/apps\/([^/]+)\//.exec(path)?.[1]].filter((app): app is string => !!app);
}

/** The repo paths a cited path may name: itself, under each of the doc's apps, and for a skill under its own folder. */
export function candidates(doc: Pick<Doc, "kind" | "path" | "apps">, ref: string): string[] {
  const out = [ref, ...doc.apps.filter(() => !ref.startsWith("apps/")).map(app => `apps/${app}/${ref}`)];
  if (doc.kind !== "page") out.push(posix.normalize(posix.join(posix.dirname(doc.path), ref)));
  return [...new Set(out)];
}

/** The first-parent commits of HEAD, newest first, from `git log --first-parent --format=%H %ct`. */
export function parseCommits(text: string): { sha: string; at: number }[] {
  return text.split("\n").flatMap(line => { const [sha = "", ct = ""] = line.trim().split(" "); const at = Number(ct) * 1000; return sha && at > 0 ? [{ sha, at }] : []; });
}

/** The newest commit at or before `at` in a newest-first list, by binary search; undefined when every commit is newer. */
export function commitAt(commits: readonly { sha: string; at: number }[], at: number): string | undefined {
  let low = 0, high = commits.length;
  while (low < high) { const mid = (low + high) >> 1; if (commits[mid]!.at <= at) high = mid; else low = mid + 1; }
  return commits[low]?.sha;
}

/** Parses `git cat-file --batch` or `--batch-check` output for `names` asked in order: each name's content (batch) or "" (check), or null when missing. */
export function parseCatFile(out: Buffer, names: readonly string[], withContent: boolean): Map<string, string | null> {
  const result = new Map<string, string | null>();
  let offset = 0;
  for (const name of names) {
    const end = out.indexOf(10, offset);
    if (end < 0) throw new Error(`git cat-file stopped before ${name}`);
    const head = out.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(head);
    if (!match) { result.set(name, null); continue; }
    if (!withContent) { result.set(name, match[1]!); continue; }
    const size = Number(match[2]);
    result.set(name, match[1] === "blob" ? out.subarray(offset, offset + size).toString("utf8") : "");
    offset += size + 1;
  }
  return result;
}

const word = (text: string, token: string): boolean => new RegExp(`(?<![\\w$-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);
const scriptNames = (json: string | null | undefined): Set<string> => {
  try { const value: unknown = json ? JSON.parse(json) : {}; return new Set(isRecord(value) && isRecord(value.scripts) ? Object.keys(value.scripts) : []); } catch { return new Set(); }
};

/**
 * Judges every doc's facts at its own commit (`revOf`) against HEAD. `objects` answers `rev:path` with the object's type, or null when missing;
 * `contents` answers `rev:path` with a blob's text; `namesAtHead` holds the env and constant names the code at HEAD still has; `namesAt` gives,
 * for each rev and its names, the ones the code at that rev had. Each doc maps to its drifts, and a doc whose cited file only changed is in `changed`.
 */
export async function judgeDocs(docs: readonly Doc[], revOf: (doc: Doc) => string | undefined, io: {
  objects: (names: readonly string[]) => Promise<Map<string, string | null>>;
  blobs: (names: readonly string[]) => Promise<Map<string, string | null>>;
  contents: (names: readonly string[]) => Promise<Map<string, string | null>>;
  namesAtHead: ReadonlySet<string>;
  namesAt: (asks: ReadonlyMap<string, readonly string[]>) => Promise<Map<string, Set<string>>>;
}): Promise<{ drifts: Map<Doc, Drift[]>; changed: Set<Doc> }> {
  const asks = new Set<string>(); const reads = new Set<string>();
  for (const doc of docs) {
    const rev = revOf(doc);
    if (!rev) continue;
    for (const fact of doc.facts) {
      if (fact.kind === "path") for (const path of candidates(doc, fact.ref)) { asks.add(`${rev}:${path}`); asks.add(`HEAD:${path}`); }
      if (fact.kind === "symbol" || fact.kind === "flag") for (const path of candidates(doc, fact.file)) { reads.add(`${rev}:${path}`); reads.add(`HEAD:${path}`); }
      if (fact.kind === "script") for (const dir of new Set(["", fact.dir])) { const file = dir ? `${dir}/package.json` : "package.json"; reads.add(`${rev}:${file}`); reads.add(`HEAD:${file}`); }
    }
  }
  const objects = await io.objects([...asks]);
  const blobIds = await io.blobs([...asks].filter(name => objects.get(name) === "blob"));
  const text = await io.contents([...reads]);
  const absent = new Map<string, Set<string>>();
  for (const doc of docs) {
    const rev = revOf(doc);
    if (!rev) continue;
    for (const fact of doc.facts) if (fact.kind === "name" && !io.namesAtHead.has(fact.ref)) absent.set(rev, (absent.get(rev) ?? new Set()).add(fact.ref));
  }
  const namesThen = absent.size ? await io.namesAt(new Map([...absent].map(([rev, names]) => [rev, [...names].sort()]))) : new Map<string, Set<string>>();

  const drifts = new Map<Doc, Drift[]>(); const changed = new Set<Doc>();
  for (const doc of docs) {
    const rev = revOf(doc);
    if (!rev) continue;
    const found: Drift[] = [];
    const since = `since ${day(doc.at)}`;
    for (const fact of doc.facts) {
      if (fact.kind === "path") {
        const paths = candidates(doc, fact.ref);
        const then = paths.filter(path => objects.get(`${rev}:${path}`));
        const now = paths.filter(path => objects.get(`HEAD:${path}`));
        if (then.length && !now.length) found.push({ fact, detail: `${fact.ref} is gone ${since}` });
        if (now.some(path => blobIds.has(`HEAD:${path}`) && blobIds.has(`${rev}:${path}`) && blobIds.get(`HEAD:${path}`) !== blobIds.get(`${rev}:${path}`))) changed.add(doc);
      } else if (fact.kind === "symbol" || fact.kind === "flag") {
        const token = fact.kind === "symbol" ? fact.name : fact.flag;
        const paths = candidates(doc, fact.file);
        const then = paths.some(path => word(text.get(`${rev}:${path}`) ?? "", token));
        const nowFiles = paths.map(path => text.get(`HEAD:${path}`)).filter((body): body is string => typeof body === "string");
        if (then && nowFiles.length && !nowFiles.some(body => word(body, token))) found.push({ fact, detail: `${fact.file} has no ${token} ${since}` });
      } else if (fact.kind === "script") {
        const files = [...new Set(["", fact.dir])].map(dir => dir ? `${dir}/package.json` : "package.json");
        const then = files.some(file => scriptNames(text.get(`${rev}:${file}`)).has(fact.name));
        const now = files.some(file => scriptNames(text.get(`HEAD:${file}`)).has(fact.name));
        if (then && !now) found.push({ fact, detail: `${fact.ref} is no package.json script ${since}` });
      } else if (!io.namesAtHead.has(fact.ref) && namesThen.get(rev)?.has(fact.ref)) {
        found.push({ fact, detail: `${fact.ref} is in no code at HEAD ${since}` });
      }
    }
    if (found.length) drifts.set(doc, found);
  }
  return { drifts, changed };
}

/** Whether a page fact is the Wiki dream's to count: a path under the folders its stale check reads. */
export const dreamOwns = (doc: Pick<Doc, "kind">, fact: Fact): boolean => doc.kind === "page" && fact.kind === "path" && DREAM_PREFIX.test(fact.ref);

/** The curated pages under `content/apps`, `content/domains` and `content/projects`, with no dot, data or assets folder, as wiki-health.mjs walks them. */
export async function listCuratedPages(content: string): Promise<string[]> {
  const files: string[] = [];
  for (const space of ["apps", "domains", "projects"]) {
    const entries = await readdir(join(content, space), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".html") || entry.name.startsWith(".")) continue;
      const rel = relative(content, join(entry.parentPath, entry.name));
      if (rel.split("/").slice(1, -1).some(part => part.startsWith(".") || part === "data" || part === "assets")) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

/**
 * Page kinds that record what happened, where an old name is the record: on the first run on 2026-11-20 the incident page
 * domains/devops/env-and-secrets/railway-breach-2026-10-21 counted for RAILWAY_TOKEN, a GitHub secret it lists as it stood on 10-22.
 */
const HISTORY_KINDS = new Set(["experiment", "incident", "postmortem"]);
/**
 * The skill folders a vendor wrote (`metadata.author` in SKILL.md's frontmatter), whose facts name the vendor's tool and not this repo's code:
 * on 2026-11-20 stack/clickhouse-best-practices (author ClickHouse Inc) counted twice for CLICKHOUSE_SECURE, an mcp-clickhouse setting.
 */
export function vendorSkillDirs(skills: ReadonlyMap<string, string>): string[] {
  const frontmatter = (text: string): string => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return [...skills].filter(([path, text]) => path.endsWith("/SKILL.md") && /^metadata:[ \t]*(?:\n[ \t]+.*)*?\n[ \t]+author:/m.test(frontmatter(text)))
    .map(([path]) => posix.dirname(path) + "/");
}

const isSkillFile = (path: string): boolean => path.startsWith(".agents/skills/") && path.endsWith(".md");
/** A rule file every agent in auto-sns-agent loads: a `.claude/rules/*.md` file or a root contract (p7, 2026-11-21: d1 read only app-*.md). */
const isRuleFile = (path: string): boolean => /^\.claude\/rules\/[^/]+\.md$/.test(path) || path === "CLAUDE.md" || path === "AGENTS.md";
/**
 * A Prime agent skill's markdown in sieun-pi: under a skill folder of skills/ or legacy/prime/skills/, which ~/.prime/agent/skills links to, or
 * of a package's skills/ (pi-rlm, pi-harness, pi-host), which Prime ships; a test fixture is no skill.
 */
export const isPrimeSkillFile = (path: string): boolean =>
  path.endsWith(".md") && /^(?:skills|legacy\/prime\/skills|packages\/[^/]+\/skills)\/[^/]+\//.test(path) && !/\/(?:tests?|fixtures)\//.test(path);

/** Measures every page, repo skill and Prime skill and builds the precheck output; an input that fails adds a source_error item and 999999 for the headline. */
export async function measureFacts(deps: FactsDeps): Promise<PrecheckOutput & { info: Record<string, number> }> {
  const errors: FlaggedSlice[] = [];
  const fail = (source: string, error: unknown): undefined => {
    errors.push({ kind: "source_error", item: source, excerpt: clip(`${source}: ${error instanceof Error ? error.message : String(error)}`) });
    return undefined;
  };
  let skipped = 0;

  /** One checkout's docs, each with the commit its facts are judged at; `broken` when a read the judge needs failed. */
  const source = (repo: string, label: string) => {
    const git = (args: readonly string[], input?: string, okCodes?: number[]) => deps.run("git", ["-C", repo, ...args], { cwd: repo, ...input === undefined ? {} : { input }, ...okCodes ? { okCodes } : {} });
    const catFile = async (names: readonly string[], mode: "--batch" | "--batch-check" | "--batch-check=%(objectname)"): Promise<Map<string, string | null>> => {
      if (!names.length) return new Map();
      const out = await git(["cat-file", mode], names.join("\n") + "\n");
      if (mode !== "--batch-check=%(objectname)") return parseCatFile(out, names, mode === "--batch");
      const lines = out.toString("utf8").split("\n");
      return new Map(names.map((name, index) => [name, /^[0-9a-f]+$/.test(lines[index] ?? "") ? lines[index]! : null]));
    };
    return { repo, label, git, catFile, docs: [] as Doc[], revs: new Map<Doc, string>(), broken: false };
  };
  type Source = ReturnType<typeof source>;

  const readSkills = async (from: Source, kind: Exclude<DocKind, "page">, roots: string[], keep: (path: string) => boolean): Promise<void> => {
    const paths = await from.git(["ls-tree", "-r", "--name-only", "HEAD", "--", ...roots])
      .then(out => out.toString("utf8").split("\n").filter(keep)).catch(error => fail(`${from.label} git ls-tree skills`, error));
    const texts = paths && await from.catFile(paths.map(path => `HEAD:${path}`), "--batch").catch(error => fail(`${from.label} git cat-file skills`, error));
    if (!paths || !texts) { from.broken = true; return; }
    const vendor = vendorSkillDirs(new Map(paths.map(path => [path, texts.get(`HEAD:${path}`) ?? ""])));
    for (const path of paths) {
      const text = texts.get(`HEAD:${path}`);
      if (!text) continue;
      if (vendor.some(dir => path.startsWith(dir))) { skipped += 1; continue; }
      const last = await from.git(["log", "-1", "--first-parent", "--format=%H %ct", "HEAD", "--", path]).then(out => parseCommits(out.toString("utf8"))[0])
        .catch(error => fail(`${from.label} git log ${path}`, error));
      if (!last) continue;
      const doc: Doc = { kind, path, at: last.at, apps: docApps(kind, path), facts: readFacts(kind, text) };
      from.docs.push(doc); from.revs.set(doc, last.sha);
    }
  };

  const auto = source(deps.repo, "auto-sns-agent"), pi = source(deps.piRepo, "sieun-pi");
  const commits = await auto.git(["log", "--first-parent", "--format=%H %ct", "HEAD"]).then(out => parseCommits(out.toString("utf8"))).catch(error => fail("auto-sns-agent git log", error));
  if (!commits) auto.broken = true;
  await readSkills(auto, "skill", [".agents/skills"], isSkillFile);
  await readSkills(auto, "rule", [".claude/rules", "CLAUDE.md", "AGENTS.md"], isRuleFile);
  await readSkills(pi, "prime_skill", ["skills", "legacy/prime/skills", "packages"], isPrimeSkillFile);
  const pagePaths = await deps.listPages().catch(error => fail("wiki pages", error));
  for (const path of pagePaths ?? []) {
    const html = await deps.readText(join(deps.content, path)).catch(error => fail(`read ${path}`, error));
    if (html === undefined) continue;
    const header = pageHeader(html);
    if (isSettledStatus(header.status) || HISTORY_KINDS.has(String(header.kind))) { skipped += 1; continue; }
    const at = Math.max(...[header.updated, header.last_verified, header.date, header.created].map(headerTime).filter(Number.isFinite));
    const rev = commits && Number.isFinite(at) ? commitAt(commits, at) : undefined;
    if (!rev) { skipped += 1; continue; }
    const apps = docApps("page", path, header);
    const doc: Doc = { kind: "page", path, at, apps, facts: readFacts("page", html).filter(fact => !dreamOwns({ kind: "page" }, fact)) };
    auto.docs.push(doc); auto.revs.set(doc, rev);
  }

  /**
   * Which asked names each rev's code had, from one `git grep` over a tree of every distinct blob the revs hold (`git mktree`, an unreachable
   * object). On 2026-11-21 one grep per rev took 209 s of a 229 s run for 51 revs and a run at load 123 took 541 s of its 600 s timeout; the
   * 51 revs held 94,038 distinct blobs against 14,113 in one tree, and one grep over them took 8.6 s.
   */
  const namesAtRevs = async (from: Source, asks: ReadonlyMap<string, readonly string[]>): Promise<Map<string, Set<string>>> => {
    const revBlobs = new Map<string, string[]>(); const modes = new Map<string, string>();
    for (const rev of asks.keys()) {
      const ids: string[] = [];
      for (const entry of (await from.git(["ls-tree", "-r", "-z", rev])).toString("utf8").split("\0")) {
        const match = /^(100644|100755) blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
        if (!match || match[3]!.endsWith(".md") || match[3]!.startsWith("apps/llm-wiki/content/")) continue;
        ids.push(match[2]!); modes.set(match[2]!, match[1]!);
      }
      revBlobs.set(rev, ids);
    }
    const tree = (await from.git(["mktree"], [...modes].map(([id, mode]) => `${mode} blob ${id}\t${id}`).join("\n") + "\n")).toString("utf8").trim();
    const names = [...new Set([...asks.values()].flat())];
    const out = await from.git(["grep", "-I", "-o", "-w", "-F", ...names.flatMap(name => ["-e", name]), tree], undefined, [1]);
    const inBlob = new Map<string, Set<string>>();
    for (const line of out.toString("utf8").split("\n")) {
      const match = /^[0-9a-f]+:([0-9a-f]+):(.+)$/.exec(line);
      if (match) inBlob.set(match[1]!, (inBlob.get(match[1]!) ?? new Set()).add(match[2]!));
    }
    return new Map([...revBlobs].map(([rev, ids]) => {
      const wanted = new Set(asks.get(rev)); const had = new Set<string>();
      for (const id of ids) for (const name of inBlob.get(id) ?? []) if (wanted.has(name)) had.add(name);
      return [rev, had];
    }));
  };

  const judgeSource = async (from: Source): Promise<Awaited<ReturnType<typeof judgeDocs>> | undefined> => {
    if (from.broken) return undefined;
    const names = [...new Set(from.docs.flatMap(doc => doc.facts.filter(fact => fact.kind === "name").map(fact => fact.ref)))].sort();
    // rg over the checkout reads HEAD plus other jobs' uncommitted edits, which can only keep a name present; git grep -f over a whole tree is
    // refused by the repo guard (one with 1,117 names ran 63 min on 2026-10-24), and rg's one pass took 3 s for 1,300 names on 2026-11-20.
    const namesAtHead = names.length ? await deps.run("rg", ["--hidden", "--no-filename", "--no-line-number", "-I", "-o", "-w", "-F", "-f", "-",
      "--glob", "!.git", "--glob", "!*.md", "--glob", "!apps/llm-wiki/content", "."], { cwd: from.repo, input: names.join("\n") + "\n", okCodes: [1] })
      .then(out => new Set(out.toString("utf8").split("\n").filter(Boolean))).catch(error => fail(`${from.label} rg names`, error)) : new Set<string>();
    if (!namesAtHead) return undefined;
    return judgeDocs(from.docs, doc => from.revs.get(doc), {
      objects: list => from.catFile(list, "--batch-check"),
      blobs: list => from.catFile(list, "--batch-check=%(objectname)"),
      contents: list => from.catFile(list, "--batch"),
      namesAtHead,
      namesAt: asks => namesAtRevs(from, asks),
    }).catch(error => fail(`${from.label} judge`, error));
  };
  const autoJudged = await judgeSource(auto);
  const piJudged = await judgeSource(pi);

  const docs = [...auto.docs, ...pi.docs];
  const stale = [...autoJudged?.drifts ?? [], ...piJudged?.drifts ?? []];
  const count = (kind: DocKind): number => stale.filter(([doc]) => doc.kind === kind).length;
  const measured = autoJudged !== undefined && piJudged !== undefined;
  const metrics: Record<string, number> = {
    docs_with_stale_facts: measured ? stale.length : UNMEASURED,
    pages_with_stale_facts: autoJudged ? count("page") : UNMEASURED,
    skills_with_stale_facts: autoJudged ? count("skill") + count("rule") : UNMEASURED,
    skills_with_stale_facts_rules: autoJudged ? count("rule") : UNMEASURED,
    prime_skills_with_stale_facts: piJudged ? count("prime_skill") : UNMEASURED,
    source_errors: errors.length,
  };
  const info: Record<string, number> = {
    pages_read: docs.filter(doc => doc.kind === "page").length, skills_read: docs.filter(doc => doc.kind === "skill").length,
    rules_read: docs.filter(doc => doc.kind === "rule").length,
    prime_skills_read: docs.filter(doc => doc.kind === "prime_skill").length, docs_skipped: skipped,
    facts_read: docs.reduce((sum, doc) => sum + doc.facts.length, 0), stale_facts: stale.reduce((sum, [, list]) => sum + list.length, 0),
    docs_with_changed_files: measured ? autoJudged.changed.size + piJudged.changed.size : UNMEASURED,
  };
  const order = (doc: Doc): number => doc.kind === "page" ? 1 : 0;
  const label = { page: "page", skill: "skill", rule: "rule file", prime_skill: "Prime skill" } as const;
  const flagged: FlaggedSlice[] = [...errors, ...stale.sort(([a], [b]) => order(a) - order(b) || a.at - b.at).map(([doc, list]): FlaggedSlice => ({
    kind: `stale_${doc.kind}`, item: doc.kind === "prime_skill" ? `sieun-pi:${doc.path}` : doc.path, handOff: true, sig: String(doc.at),
    excerpt: clip(`${label[doc.kind]} dated ${day(doc.at)}: ${list.map(drift => drift.detail).join("; ")}`, 600),
  }))];
  return { metrics, flagged, info };
}

export const runNoShell: Run = (file, args, options) => new Promise((done, failed) => {
  const child = spawn(file, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = []; const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.on("error", failed);
  child.on("close", code => {
    if (code === 0 || (code !== null && options.okCodes?.includes(code))) { done(Buffer.concat(out)); return; }
    failed(new Error(`${file} ${args.slice(0, 4).join(" ")} exit ${code}: ${Buffer.concat(err).toString("utf8").trim().split("\n").slice(-2).join(" ")}`));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input ?? "");
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("wiki-skill-facts: OUTPUT_FILE is not set\n"); process.exit(2); }
  const content = wikiContentDir();
  const result = await measureFacts({
    run: runNoShell, repo: process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent"), piRepo: piCheckout(dirname(fileURLToPath(import.meta.url))), content,
    readText: path => readFile(path, "utf8"), listPages: () => listCuratedPages(content),
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (result.metrics.docs_with_stale_facts === UNMEASURED) {
    const inputs = (result.flagged ?? []).filter(slice => slice.kind === "source_error").map(slice => slice.excerpt);
    process.stderr.write(`wiki-skill-facts: could not measure: ${inputs.join("; ")}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

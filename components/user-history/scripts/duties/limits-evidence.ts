import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The precheck of the "Limits rest on evidence" duty (`node --import tsx scripts/duties/limits-evidence.ts`). It lists the limit-like code in
 * auto-sns-agent with rg (caps, ceilings, budgets, throttles, timeouts, backoffs, retries, batch sizes, concurrency, and "to be safe" comments),
 * marks what is new since the last run, and reads the duty's ledger in the wiki for what the duty job already kept with evidence or removed.
 * No model call: the duty job judges each candidate. The full list, new ones first, goes to OUTPUT_FILE as `candidates`.
 * It also searches the trees the ledger's drops ride for lines that still name a dropped limit (`leftovers`), and with `--leftovers <base> <tip>`
 * it runs that search for one stack before its push.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const LEDGER_PATH = "apps/llm-wiki/content/domains/devops/limits-ledger.json";
export const ROOTS = ["apps", "convex", "ops", "scripts", "packages"] as const;
/** Source files only; tests, generated code, builds and the wiki's 59 GB content tree are left out. */
export const GLOBS = ["*.{ts,tsx,js,mjs,cjs,svelte,py,toml,yaml,yml,sh}", "!apps/llm-wiki/content/**", "!**/_generated/**", "!**/*.test.*", "!**/*.spec.*",
  "!**/test/**", "!**/tests/**", "!**/__tests__/**", "!**/e2e/**", "!**/*.d.ts", "!**/dist/**", "!**/build/**", "!**/*.min.js", "!**/node_modules/**"];
export type Kind = "const" | "literal" | "comment";
/** rg patterns: a named constant like MAX_ROWS or FETCH_TIMEOUT_MS, a key set to a number like `concurrency: 4`, and a comment that hedges. */
export const PATTERNS: Record<Kind, string> = {
  const: String.raw`\b[A-Z][A-Z0-9_]*(MAX|LIMIT|CAP|CEILING|BUDGET|THROTTLE|TIMEOUT|BACKOFF|CONCURRENCY|RATE|BATCH|RETRIES)[A-Z0-9_]*\s*(:[^=]+)?=\s*[^=>\s"'\x60]`,
  literal: String.raw`\b(max[A-Za-z0-9_]*|[A-Za-z0-9_]*([Ll]imit|[Cc]ap|[Cc]eiling|[Bb]udget|[Tt]hrottle|[Cc]oncurrency|[Bb]atch_?[Ss]ize|[Tt]imeout|[Bb]ackoff|[Rr]ate_?[Ll]imit|[Rr]etries|[Rr]ps|[Qq]ps))\s*[:=]\s*[0-9][0-9_.]*`,
  comment: String.raw`(?i)(//|#|/\*|^\s*\*|""").*\b(conservative|to be safe|caution|safety margin|just in case|on the safe side)`,
};
/** Layout and number-format sizes, such as a panel's max height or maximumFractionDigits, limit no work. */
const LAYOUT = /height|width|px|cols|columns|rows|zoom|scale|opacity|datapoints|digits/i;

/** What the duty job decided about a candidate: kept with evidence, not a limit at all, removed, unbacked with its removal on the way, or the owner's call. */
export type Verdict = "kept" | "not_limit" | "removed" | "unbacked" | "owner";
export interface LedgerEntry { verdict: Verdict; evidence?: string; commit?: string; at?: string }
export interface LedgerRun { at: string; found: number; removed: number; kept: number; owner?: number }
/** The duty job's ledger in the wiki: a verdict per candidate key, and per run how many unbacked limits it found and removed. */
export interface Ledger { limits: Record<string, LedgerEntry>; runs: LedgerRun[] }
export interface Candidate { key: string; app: string; file: string; line: number; kind: Kind; match: string; text: string; new: boolean; verdict?: Verdict }
type Found = Pick<Candidate, "file" | "line" | "kind" | "match" | "text">;
/** The candidate keys of the last run, so the next run can name what is new. */
export interface LimitsState { keys: string[] }
/** The limit a drop commit removes, from its subject `chore(<app>): drop unbacked limit <name>`. */
export const DROP_SUBJECT = /^chore\([^)]*\): drop unbacked limit (\S+)/;
/** A name a whole-word search can trace alone: a constant or env var like CH_INSERT_TIMEOUT_MS. A lowercase key such as `timeout` or `max_bytes`
 * also names unrelated code, so the playbook's rg step covers those by hand. */
export const TRACEABLE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
/** A line in a commit's tree that still names a dropped limit. */
export interface Leftover { name: string; file: string; line: number; text: string }
/** A dropped limit whose name the tree of `rev` still uses: the ledger key, and the ref or commit searched. */
export interface LeftoverFinding { key: string; rev: string; hits: Leftover[] }

/** The app a file belongs to: apps/<x> and packages/<x> by name, everything else by its top folder (convex, ops, scripts). */
export function appOf(file: string): string {
  const [top, name] = file.split("/");
  return (top === "apps" || top === "packages") && name ? name : top!;
}

/** The matches in rg `--json` output; layout sizes are dropped. */
export function parseRg(kind: Kind, json: string): Found[] {
  const found: Found[] = [];
  for (const line of json.split("\n")) {
    if (!line.startsWith('{"type":"match"')) continue;
    const { data } = JSON.parse(line) as { data: { path: { text: string }; lines: { text?: string }; line_number: number; submatches: { match: { text?: string } }[] } };
    const match = (data.submatches[0]?.match.text ?? "").replace(/\s+/g, " ").trim();
    if (kind !== "comment" && LAYOUT.test(match.split(/[\s:=]/)[0]!)) continue;
    found.push({ file: data.path.text, line: data.line_number, kind, match: kind === "comment" ? match.slice(-60) : kind === "const" ? match.split(/[\s:=]/)[0]! : match.replace(/\s*([:=])\s*/, "$1"),
      text: (data.lines.text ?? "").trim().slice(0, 200) });
  }
  return found;
}

/** Keys that survive edits elsewhere in a file: the file and the match, with the occurrence number when the same match repeats in that file. */
export function withKeys(found: readonly Found[]): Omit<Candidate, "new" | "verdict">[] {
  const seen = new Map<string, number>();
  return [...found].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind)).map(hit => {
    const base = `${hit.file}#${hit.match}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: count > 1 ? `${base}#${count}` : base, app: appOf(hit.file), ...hit };
  });
}

/** The ledger from its JSON text; a missing file is an empty ledger. Throws on a file that is not a ledger. */
export function parseLedger(text: string | undefined): Ledger {
  if (text === undefined) return { limits: {}, runs: [] };
  const value = JSON.parse(text) as Partial<Ledger>;
  if (typeof value !== "object" || value === null || typeof value.limits !== "object" || !Array.isArray(value.runs)) throw new Error("not a ledger: it needs limits and runs");
  return { limits: value.limits ?? {}, runs: value.runs };
}

export function measureLimits(found: readonly Found[], previous: LimitsState | undefined, ledger: Ledger | { error: string }, at: number,
  left: readonly LeftoverFinding[] = []): { output: PrecheckOutput & { candidates: Candidate[]; ledger: string; leftovers: LeftoverFinding[] }; state: LimitsState } {
  const known = previous && new Set(previous.keys);
  const limits = "error" in ledger ? {} : ledger.limits;
  const candidates: Candidate[] = withKeys(found).map(hit => ({ ...hit, new: known ? !known.has(hit.key) : false, ...(limits[hit.key] ? { verdict: limits[hit.key]!.verdict } : {}) }));
  const live = new Set(candidates.map(hit => hit.key));
  const entries = Object.entries(limits);
  const where = (key: string) => candidates.find(hit => hit.key === key);
  const lastRun = "error" in ledger ? undefined : ledger.runs.at(-1);
  const unbacked = entries.filter(([key, entry]) => entry.verdict === "unbacked" && live.has(key));
  const back = entries.filter(([key, entry]) => entry.verdict === "removed" && live.has(key));
  const bare = entries.filter(([, entry]) => entry.verdict === "kept" && !entry.evidence?.trim());
  const owner = entries.filter(([key, entry]) => entry.verdict === "owner" && live.has(key));
  const metrics = {
    unjudged: candidates.filter(hit => !hit.verdict).length,
    unbacked_left: unbacked.length,
    removed_back: back.length,
    kept_no_evidence: bare.length,
    owner_calls: owner.length,
    unbacked_found: lastRun?.found ?? 0,
    unbacked_removed: lastRun?.removed ?? 0,
    ledger_errors: "error" in ledger ? 1 : 0,
    leftover_refs: left.length,
  };
  const flagged: FlaggedSlice[] = [];
  if ("error" in ledger) flagged.push({ at, kind: "ledger", excerpt: `${LEDGER_PATH}: ${ledger.error}`.slice(0, 300) });
  if (!known) flagged.push({ at, kind: "baseline", excerpt: `first run: ${candidates.length} candidates saved as the baseline; later runs flag each new one` });
  const apps = [...new Set(candidates.map(hit => hit.app))].sort();
  for (const app of apps) {
    const mine = candidates.filter(hit => hit.app === app);
    const count = (test: (hit: Candidate) => boolean) => mine.filter(test).length;
    flagged.push({ at, kind: "app", item: app, excerpt: `${count(() => true)} candidates, ${count(hit => hit.new)} new, ${count(hit => !hit.verdict)} unjudged, ` +
      `${count(hit => hit.verdict === "kept")} kept, ${count(hit => hit.verdict === "unbacked")} unbacked waiting to land` });
  }
  const line = (hit: Candidate | undefined, key: string) => hit ? `${hit.file}:${hit.line} ${hit.text}` : key;
  for (const hit of candidates.filter(entry => entry.new)) flagged.push({ at, kind: "new", item: hit.app, excerpt: line(hit, hit.key) });
  for (const [key] of back) flagged.push({ at, kind: "back", excerpt: `removed before, in the code again: ${line(where(key), key)}` });
  for (const [key, entry] of unbacked) flagged.push({ at, kind: "unbacked", excerpt: `${line(where(key), key)}${entry.commit ? ` (removal ${entry.commit})` : ""}` });
  for (const [key] of bare) flagged.push({ at, kind: "no_evidence", excerpt: `kept with no evidence written: ${key}` });
  for (const [key] of owner) flagged.push({ at, kind: "owner", excerpt: `waits for the owner's call: ${line(where(key), key)}` });
  for (const { key, rev, hits } of left) flagged.push({ at, kind: "leftover", item: appOf(key), excerpt: (`dropped ${hits[0]!.name} (${key}), but ${rev} still names it in ` +
    `${hits[0]!.file}:${hits[0]!.line} ${hits[0]!.text}${hits.length > 1 ? ` and ${hits.length - 1} more lines` : ""}`).slice(0, 300) });
  candidates.sort((a, b) => Number(b.new) - Number(a.new) || a.app.localeCompare(b.app) || a.file.localeCompare(b.file) || a.line - b.line);
  return { output: { metrics, flagged, candidates, ledger: join(REPO, LEDGER_PATH), leftovers: [...left] }, state: { keys: candidates.map(hit => hit.key).sort() } };
}

function git(repo: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd: repo, encoding: "utf8", maxBuffer: Infinity }, (error, stdout, stderr) => {
    const code = error ? typeof error.code === "number" ? error.code : -1 : 0;
    if (code === 0 || code === 1) resolve({ code, stdout }); else reject(new Error(`git ${args[0]}: ${String(stderr).trim() || error!.message}`));
  }));
}

/** The lines in the tree of `rev` that name one of `names` as a whole word, outside the wiki content. git grep reads the commit, so nothing is checked out. */
export async function leftovers(repo: string, rev: string, names: readonly string[]): Promise<Leftover[]> {
  if (!names.length) return [];
  const { stdout } = await git(repo, ["grep", "-z", "-n", "-I", "-w", "-F", "--full-name", ...names.flatMap(name => ["-e", name]), rev, "--", ".", ":(exclude)apps/llm-wiki/content"]);
  const hits: Leftover[] = [];
  for (const row of stdout.split("\n")) {
    const [path, line, text] = row.split("\0");
    if (!path || !line || text === undefined) continue;
    const words = new Set(text.split(/[^A-Za-z0-9_]+/));
    for (const name of names) if (words.has(name)) hits.push({ name, file: path.slice(rev.length + 1), line: Number(line), text: text.trim().slice(0, 200) });
  }
  return hits;
}

/** `file#NAME` for each file whose hits include its own definition of NAME, like `const NAME = 5` or `NAME: int = 5`; that file uses its own limit. */
export function ownDefinitions(hits: readonly Leftover[]): Set<string> {
  return new Set(hits.filter(hit => new RegExp(String.raw`(^|[^.\w])${hit.name}\s*(:[^=]+)?=(?![=>])`).test(hit.text)).map(hit => `${hit.file}#${hit.name}`));
}

/** The leftover lines of one drop: hits on its name, less the files that define their own limit of that name, unless the drop's own files do. */
export function dropLeftovers(hits: readonly Leftover[], name: string, dropFiles: ReadonlySet<string>, elsewhere: ReadonlySet<string>): Leftover[] {
  return hits.filter(hit => hit.name === name && (dropFiles.has(hit.file) || !elsewhere.has(`${hit.file}#${name}`)));
}

/** The drop commits in `base..tip`: the name each subject drops and the files the commit touched. */
export async function drops(repo: string, base: string, tip: string): Promise<{ name: string; files: Set<string> }[]> {
  const { stdout } = await git(repo, ["log", "--format=%x00%s", "--name-only", `${base}..${tip}`]);
  return stdout.split("\0").slice(1).flatMap(block => {
    const [subject = "", ...files] = block.split("\n").filter(Boolean);
    const name = DROP_SUBJECT.exec(subject)?.[1];
    return name ? [{ name, files: new Set(files) }] : [];
  });
}

/** The ref a ledger entry's removal rides: the first `on ci/<ref>` or `in ci/<ref>` its `commit` text names, as fetched from origin or as a local branch. */
async function stackRef(repo: string, commit: string | undefined): Promise<string | undefined> {
  const ref = commit?.match(/\b(?:on|in) (ci\/[A-Za-z0-9._\/-]*[A-Za-z0-9])/)?.[1];
  for (const name of ref ? [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`] : []) if ((await git(repo, ["rev-parse", "--verify", "-q", name])).code === 0) return name;
  return undefined;
}

/**
 * The dropped limits whose name a tree still uses. A `removed` entry is searched on `tip`, an `unbacked` one on the ci/ ref of its stack.
 * Only TRACEABLE names are searched. A file that defines its own limit of the same name, as `defined` (`file#NAME` from the scan) or another
 * ledger key shows, uses that one, so its lines do not count.
 */
export async function findLeftovers(repo: string, ledger: Ledger, defined: ReadonlySet<string>, tip = "sieun/dev"): Promise<LeftoverFinding[]> {
  const byRev = new Map<string, { name: string; key: string }[]>();
  for (const [key, entry] of Object.entries(ledger.limits)) {
    const name = key.split("#")[1] ?? "";
    if (!TRACEABLE.test(name)) continue;
    const rev = entry.verdict === "removed" ? tip : entry.verdict === "unbacked" ? await stackRef(repo, entry.commit) : undefined;
    if (rev) byRev.set(rev, [...byRev.get(rev) ?? [], { name, key }]);
  }
  const findings: LeftoverFinding[] = [];
  for (const [rev, dropped] of byRev) {
    const hits = await leftovers(repo, rev, [...new Set(dropped.map(drop => drop.name))]);
    const elsewhere = new Set([...ownDefinitions(hits), ...defined, ...Object.keys(ledger.limits)]);
    for (const { name, key } of dropped) {
      const mine = dropLeftovers(hits, name, new Set([key.split("#")[0]!]), elsewhere);
      if (mine.length) findings.push({ key, rev: rev.replace(/^refs\/(remotes\/origin|heads)\//, ""), hits: mine });
    }
  }
  return findings;
}

/** `limits-evidence.ts --leftovers <base> <tip>`: every line in the tip's tree that still names a limit a drop commit in base..tip removed. Exits 1 on any. */
async function checkStack(base: string, tip: string): Promise<void> {
  const stack = await drops(REPO, base, tip);
  const traced = stack.filter(drop => TRACEABLE.test(drop.name));
  const hits = await leftovers(REPO, tip, [...new Set(traced.map(drop => drop.name))]);
  const elsewhere = ownDefinitions(hits);
  const left = new Map<string, Leftover>();
  for (const drop of traced) for (const hit of dropLeftovers(hits, drop.name, drop.files, elsewhere)) left.set(`${hit.file}:${hit.line}:${hit.name}`, hit);
  for (const hit of left.values()) process.stdout.write(`${hit.name}\t${hit.file}:${hit.line}\t${hit.text}\n`);
  const untraced = [...new Set(stack.filter(drop => !TRACEABLE.test(drop.name)).map(drop => drop.name))];
  process.stdout.write(`${left.size} leftover lines for ${traced.length} dropped names in ${tip}${untraced.length ? `; rg these by hand: ${untraced.join(", ")}` : ""}\n`);
  process.exit(left.size ? 1 : 0);
}

/** Runs the 3 searches over the source roots the repo has; rg exit 1 means no match. */
export async function scan(repo: string): Promise<Found[]> {
  const roots = ROOTS.filter(root => existsSync(join(repo, root)));
  const searches = (Object.keys(PATTERNS) as Kind[]).map(kind => new Promise<Found[]>((resolve, reject) => {
    execFile("rg", ["--json", ...GLOBS.flatMap(glob => ["-g", glob]), "-e", PATTERNS[kind], ...roots], { cwd: repo, encoding: "utf8", maxBuffer: Infinity },
      (error, stdout, stderr) => error && error.code !== 1 ? reject(new Error(`rg ${kind}: ${String(stderr).trim() || error.message}`)) : resolve(parseRg(kind, stdout)));
  }));
  return (await Promise.all(searches)).flat();
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--leftovers");
  if (at >= 0) {
    const [base, tip] = process.argv.slice(at + 1);
    if (!base || !tip) { process.stderr.write("usage: limits-evidence.ts --leftovers <base> <tip>\n"); process.exit(2); }
    return checkStack(base, tip);
  }
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("limits-evidence: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as Partial<LimitsState>, () => undefined) : undefined;
  const ledgerText = await readFile(join(REPO, LEDGER_PATH), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  let ledger: Ledger | { error: string };
  try { ledger = parseLedger(ledgerText); } catch (error) { ledger = { error: error instanceof Error ? error.message : String(error) }; }
  const found = await scan(REPO);
  const left = "error" in ledger ? [] : await findLeftovers(REPO, ledger, new Set(found.map(hit => `${hit.file}#${hit.match}`)));
  const result = measureLimits(found, Array.isArray(previous?.keys) ? { keys: previous.keys } : undefined, ledger, Date.now(), left);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

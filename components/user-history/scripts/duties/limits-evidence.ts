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

export function measureLimits(found: readonly Found[], previous: LimitsState | undefined, ledger: Ledger | { error: string }, at: number):
  { output: PrecheckOutput & { candidates: Candidate[]; ledger: string }; state: LimitsState } {
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
  candidates.sort((a, b) => Number(b.new) - Number(a.new) || a.app.localeCompare(b.app) || a.file.localeCompare(b.file) || a.line - b.line);
  return { output: { metrics, flagged, candidates, ledger: join(REPO, LEDGER_PATH) }, state: { keys: candidates.map(hit => hit.key).sort() } };
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
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("limits-evidence: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as Partial<LimitsState>, () => undefined) : undefined;
  const ledgerText = await readFile(join(REPO, LEDGER_PATH), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  let ledger: Ledger | { error: string };
  try { ledger = parseLedger(ledgerText); } catch (error) { ledger = { error: error instanceof Error ? error.message : String(error) }; }
  const result = measureLimits(await scan(REPO), Array.isArray(previous?.keys) ? { keys: previous.keys } : undefined, ledger, Date.now());
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

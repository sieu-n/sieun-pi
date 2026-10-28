import { execFile } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Staging design rules duty's precheck (`node --import tsx scripts/duties/staging-design-rules.ts`) for frontend bro. It runs on the owner's
 * Mac over `ssh mac`, where the chat's log and the 5180 demo live. No model call, no browser. The owner, 10-12: "make sure i'll not give the
 * same feedback". Judged metrics:
 * - repeated_design_notes_24h, the headline: the owner's messages in this chat in the last 24 h that repeat a design rule he already gave. A
 *   rule counts as given from the earliest of its ledger corrections in force, the date its frontend-implementation skill text was written,
 *   and the first owner message that asked for it. The rules and the patterns of his words for each are in staging-design-rules.rules.json.
 * - design_rule_test_failures: failed tests in the virev-demo unit tests that catch a design rule by script (each rule's `tests`).
 *   A repeat stops counting once it is handled: the rules file's `handled` names the note's time and the commits that wrote its skill line and
 *   fixed its pages, and every one of those commits is on origin at the Mac's dev branch (dev/sieun-mac). The note itself cannot be unsent, so without this the
 *   number sat at 1 for a day after the 10-22 08:28Z Settings note was already fixed and written down, and each run asked for a fix job
 *   with nothing left to fix.
 * Run detail: design_notes_24h (notes that match any rule), handled_repeats_24h (repeats in 24 h whose handling is on origin), rules_not_written (rules he repeated in 24 h with no correction in force and no
 * skill text), search_design_rule_findings (tests of the same rules in the real app, apps/search on us-metal02, each rule's `searchTests`,
 * that fail with DESIGN_RULES_STRICT=1, which makes the rules still in warn-only mode strict), source_errors. A source this check cannot read adds 1 to the metric it feeds and a flagged slice.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const DAY_MS = 24 * 3_600_000;
/** User lines another agent or the harness wrote that do not open with "[", so only their opening tells them from the owner's own words. */
const INJECTED = /^(<skill |Prime Agent restarted|This session moved|The owner asked me)/;

export interface DesignRule { key: string; rule: string; corrections: string[]; skill: string | null; skillSince: string | null; match: string[]; unless?: string; tests?: string[]; searchTests?: string[] }
export interface OwnerNote { at: number; text: string }
interface Correction { id: string; at?: string; status?: string }
/** A repeated note already dealt with: its time (ISO, the log line's timestamp) and the auto-sns-agent commits that handled it. */
export interface HandledRepeat { at: string; commits: string[]; why: string }

/** The owner's own messages in a session log: user lines no job, check-in or tool wrote, and his board answers. */
export async function ownerNotes(file: string): Promise<OwnerNote[]> {
  const notes: OwnerNote[] = [];
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    if (!line.includes('"role":"user"')) continue;
    let entry: { timestamp?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = (typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part as { text?: unknown }).text).filter(t => typeof t === "string").join("\n") : "").trim();
    if (!text || (text.startsWith("[") && !text.startsWith("[board] Owner")) || INJECTED.test(text)) continue;
    notes.push({ at: Date.parse(entry.timestamp ?? ""), text });
  }
  return notes;
}

/** The rule keys a note asks for, read from his own lines only: lines quoting the chat ("> ...") are dropped first. */
export function rulesIn(rules: readonly DesignRule[], text: string): string[] {
  const own = text.split("\n").filter(line => !line.trimStart().startsWith(">")).join("\n");
  return rules.filter(rule => !(rule.unless && new RegExp(rule.unless, "i").test(own)) && rule.match.some(pattern => new RegExp(pattern, "i").test(own))).map(rule => rule.key);
}

export interface Repeat { at: number; text: string; rules: string[] }

/**
 * Each note in the window that repeats a rule given before it. `givenAt` holds each rule's written date (ledger or skill); a rule with none is
 * given by the first note that asks for it.
 */
export function repeats(rules: readonly DesignRule[], notes: readonly OwnerNote[], givenAt: ReadonlyMap<string, number>, from: number): { repeats: Repeat[]; matched: number; counts: Map<string, number> } {
  const given = new Map(givenAt);
  const out: Repeat[] = [];
  const counts = new Map<string, number>();
  let matched = 0;
  for (const note of [...notes].sort((a, b) => a.at - b.at)) {
    const keys = rulesIn(rules, note.text);
    const repeated = keys.filter(key => (given.get(key) ?? Infinity) < note.at);
    for (const key of keys) {
      if (!given.has(key) || given.get(key)! > note.at) given.set(key, note.at);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (note.at < from) continue;
    if (keys.length) matched++;
    if (repeated.length) out.push({ at: note.at, text: note.text, rules: repeated });
  }
  return { repeats: out, matched, counts };
}

const exec = (file: string, args: readonly string[], cwd: string): Promise<void> => new Promise(resolve => {
  // vitest exits 1 when a test fails; the JSON report it writes is what this check reads, so the exit code is not an error here.
  execFile(file, [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, () => resolve());
});

/** The stdout of a command, whatever its exit code: the remote vitest run prints its JSON report there. */
const capture = (file: string, args: readonly string[]): Promise<string> => new Promise(resolve => {
  execFile(file, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ""));
});

/** The real app's checkout on us-metal02, where the apps/search design rule tests run. */
const SEARCH_HOST = "us-metal02";
const SEARCH_DIR = "/home/sieun/Documents/Github/auto-sns-agent/apps/search";

/** The ssh command that runs the apps/search rule tests strict on us-metal02 and prints vitest's JSON report. */
export function searchRun(tests: readonly string[], host = SEARCH_HOST, dir = SEARCH_DIR): [string, string[]] {
  const run = `cd ${dir} && f=$(mktemp) && DESIGN_RULES_STRICT=1 pnpm exec vitest run ${tests.join(" ")} --reporter=json --outputFile=$f >/dev/null 2>&1; cat $f; rm -f $f`;
  return ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `bash -lc '${run}'`]];
}

interface VitestReport { testResults?: { name?: string; assertionResults?: { fullName?: string; status?: string; failureMessages?: string[] }[] }[] }

/** The Mac checkout's own dev branch (c119): its `agent.branch`, else its current branch, so the check follows the Mac's move to dev/sieun-mac. */
export async function devBranch(repo: string): Promise<string> {
  for (const args of [["config", "--get", "agent.branch"], ["branch", "--show-current"]]) {
    const out = await new Promise<string>(resolve => execFile("git", args, { cwd: repo, encoding: "utf8" }, (_error, stdout) => resolve((stdout ?? "").trim())));
    if (out) return out;
  }
  throw new Error(`${repo} has no agent.branch and no current branch`);
}

export async function measure(opts: { now: number; sessionFile: string; ledgerFile: string; skillFile: string; rulesFile: string; demoDir: string; vitest: string; search?: (tests: readonly string[]) => Promise<string>; landed?: (commit: string) => Promise<boolean>; landedRef?: string }): Promise<PrecheckOutput> {
  const { now } = opts;
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = { repeated_design_notes_24h: 0, design_rule_test_failures: 0, design_notes_24h: 0, handled_repeats_24h: 0, rules_not_written: 0, search_design_rule_findings: 0, source_errors: 0 };
  const lastEventAt: Record<string, number> = {};
  const sourceError = (metric: string, excerpt: string): void => { metrics[metric]!++; metrics.source_errors!++; flagged.push({ at: now, kind: "source_error", excerpt }); };

  const { rules, handled = [] } = JSON.parse(await readFile(opts.rulesFile, "utf8")) as { rules: DesignRule[]; handled?: HandledRepeat[] };
  const ledger = await readFile(opts.ledgerFile, "utf8").then(text => (JSON.parse(text) as { corrections: Correction[] }).corrections).catch((error: unknown) => {
    sourceError("repeated_design_notes_24h", `corrections ledger ${opts.ledgerFile}: ${error instanceof Error ? error.message : String(error)}`);
    return [] as Correction[];
  });
  const skill = await readFile(opts.skillFile, "utf8").catch((error: unknown) => {
    sourceError("repeated_design_notes_24h", `frontend-implementation skill ${opts.skillFile}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  });
  const inForce = new Map(ledger.filter(entry => entry.status !== "retired").map(entry => [entry.id, Date.parse(entry.at ?? "")]));
  const givenAt = new Map<string, number>();
  const written = new Set<string>();
  for (const rule of rules) {
    const dates = rule.corrections.filter(id => inForce.has(id)).map(id => inForce.get(id)!);
    if (dates.length) written.add(rule.key);
    if (rule.skill && skill.includes(rule.skill)) {
      written.add(rule.key);
      if (rule.skillSince) dates.push(Date.parse(`${rule.skillSince}T00:00:00Z`));
    }
    const first = Math.min(...dates.filter(Number.isFinite));
    if (Number.isFinite(first)) givenAt.set(rule.key, first);
  }

  try {
    const result = repeats(rules, await ownerNotes(opts.sessionFile), givenAt, now - DAY_MS);
    metrics.design_notes_24h = result.matched;
    const open: Repeat[] = [];
    for (const entry of result.repeats) {
      const done = handled.find(item => Date.parse(item.at) === entry.at);
      const missing = done ? (await Promise.all(done.commits.map(async commit => (await opts.landed?.(commit)) ? null : commit))).filter(c => c !== null) : [];
      if (done && done.commits.length && !missing.length) { metrics.handled_repeats_24h!++; continue; }
      open.push(entry);
      const text = entry.text.replace(/\s+/g, " ");
      const excerpt = done ? `handled in ${done.commits.join(", ")}, but ${missing.join(", ") || "no commit"} is not on ${opts.landedRef ?? "the Mac's dev branch (dev/sieun-mac)"} yet: ${text}` : text;
      flagged.push({ chat: CHAT, at: entry.at, kind: "design_rule_repeat", item: entry.rules.join(","), excerpt: excerpt.length > 240 ? `${excerpt.slice(0, 239)}…` : excerpt });
    }
    metrics.repeated_design_notes_24h! += open.length;
    if (open.length) lastEventAt.repeated_design_notes_24h = Math.max(...open.map(entry => entry.at));
    const repeatedKeys = new Set(result.repeats.flatMap(entry => entry.rules));
    for (const rule of rules) {
      if (!repeatedKeys.has(rule.key) || written.has(rule.key)) continue;
      metrics.rules_not_written!++;
      flagged.push({ at: now, kind: "rule_not_written", item: rule.key, excerpt: `"${rule.rule}" is in no correction in force and not in the frontend-implementation skill, and the owner gave it ${result.counts.get(rule.key) ?? 0} times` });
    }
    flagged.push({ at: now, kind: "rule_counts", excerpt: `owner notes per rule, whole thread: ${rules.map(rule => `${rule.key} ${result.counts.get(rule.key) ?? 0}`).join(", ")}` });
  } catch (error) {
    sourceError("repeated_design_notes_24h", `chat log ${opts.sessionFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tests = [...new Set(rules.flatMap(rule => rule.tests ?? []))];
  const searchTests = [...new Set(rules.flatMap(rule => rule.searchTests ?? []))];
  // The apps/search run on us-metal02 shares nothing with the demo run on the Mac, so it starts first and runs beside it. Run one after the
  // other they took 185 s at 04:53Z on 10-28, past the 180 s precheck timeout, with the demo's shared-ui.test.ts alone at 56 s.
  const searchReport = searchTests.length && opts.search ? opts.search(searchTests) : undefined;
  const report = join(tmpdir(), `staging-design-rules-${process.pid}.json`);
  await exec(opts.vitest, ["run", ...tests, "--reporter=json", `--outputFile=${report}`], opts.demoDir);
  try {
    const parsed = JSON.parse(await readFile(report, "utf8")) as VitestReport;
    const seen = new Set((parsed.testResults ?? []).map(file => file.name ?? ""));
    for (const test of tests) if (![...seen].some(name => name.endsWith(test))) sourceError("design_rule_test_failures", `vitest wrote no result for ${test}`);
    for (const file of parsed.testResults ?? []) for (const result of file.assertionResults ?? []) {
      if (result.status !== "failed") continue;
      metrics.design_rule_test_failures!++;
      const first = (result.failureMessages?.[0] ?? "").split("\n")[0]!.slice(0, 200);
      flagged.push({ at: now, kind: "design_test_failed", item: (file.name ?? "").replace(`${opts.demoDir}/`, ""), excerpt: `${result.fullName}: ${first}` });
    }
  } catch (error) {
    sourceError("design_rule_test_failures", `vitest report for ${tests.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await rm(report, { force: true }); }

  if (searchReport) {
    try {
      const parsed = JSON.parse(await searchReport) as VitestReport;
      const seen = new Set((parsed.testResults ?? []).map(file => file.name ?? ""));
      for (const test of searchTests) if (![...seen].some(name => name.endsWith(test))) sourceError("search_design_rule_findings", `apps/search vitest wrote no result for ${test}`);
      for (const file of parsed.testResults ?? []) for (const result of file.assertionResults ?? []) {
        if (result.status !== "failed") continue;
        metrics.search_design_rule_findings!++;
        const first = (result.failureMessages?.[0] ?? "").split("\n")[0]!.slice(0, 200);
        flagged.push({ at: now, kind: "search_design_test_failed", item: (file.name ?? "").replace(`${SEARCH_DIR}/`, "apps/search/"), excerpt: `${result.fullName}: ${first}` });
      }
    } catch (error) {
      sourceError("search_design_rule_findings", `apps/search vitest report on ${SEARCH_HOST} for ${searchTests.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { metrics, flagged, lastEventAt };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("staging-design-rules: OUTPUT_FILE is not set\n"); process.exit(2); }
  const repo = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
  const landedRef = `origin/${await devBranch(repo)}`;
  const result = await measure({
    now: Date.now(),
    sessionFile: process.env.SESSION_FILE || join(homedir(), `.prime/agent/sessions/${CHAT}.jsonl`),
    ledgerFile: join(homedir(), ".prime/agent/browser-chat/corrections.json"),
    skillFile: join(repo, ".agents/skills/workflows/frontend-implementation/SKILL.md"),
    rulesFile: join(HERE, "staging-design-rules.rules.json"),
    demoDir: join(repo, "apps/virev-demo"),
    vitest: join(repo, "node_modules/.bin/vitest"),
    search: tests => capture(...searchRun(tests)),
    landedRef,
    landed: commit => new Promise(resolve => {
      execFile("git", ["merge-base", "--is-ancestor", commit, landedRef], { cwd: repo }, error => resolve(!error));
    }),
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { wikiContentDir } from "../../src/chat-wiki.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { listCuratedPages, pageHeader } from "./wiki-skill-facts.ts";

/**
 * The Wiki tidiness duty's precheck (`node --import tsx scripts/duties/wiki-tidiness.ts`), for the owner's #sw-factory-build p234 (msg mwwklmfk,
 * 2026-11-26): "llm-wiki, agent file update & stale 쳐내고", and his "slop slop slop slop blocks of text" on a curated page (#dev-api-portal p33).
 * It reads the live pages under apps/ and domains/ on disk and counts two kinds of page a reader still sees there:
 *   retired_pages_shown: a page whose status is superseded, deprecated, archived or retired, or a one-off record (a title that carries a date,
 *     such as "Root free space 10-25", or kind incident or postmortem). `<wiki-children>` hides a retired page, but the sidebar tree
 *     (apps/wiki wiki-tree.ts `listed`) hides only a moved page's redirect stub, so every such page outside archive/ still shows there.
 *   pages_off_shape: a live page that reads as a wall of text by the prose lint (apps/wiki/src/lib/prose-lint.mjs, the rules of
 *     skills/wiki/references/writing.md): a paragraph over 3 sentences or 80 words, 100 words or more of prose before the first diagram or
 *     table, or any other lint error (`wallFindings`). The lint's own 2 sentences or 50 words flagged pages that read fine.
 * projects/ is left out, because a project page records a bounded initiative whose end state it keeps, and the lint's core rules cover only
 * apps/ and domains/. Other duties own the rest: the Wiki dream (wiki-dream.ts) counts links, dates, missing meta, unlisted pages and the
 * core-length warning past 800 words, so a long page counts here only for an error; d1 (wiki-skill-facts.ts) counts stale code facts; and
 * Agent factory's d7 (apps/chat agent-boards.ts `wikiClutter`) counts dated-path pages no curated page links, so a dated path alone is not read.
 * The headline pages_needing_fix is their sum, and a retired page is not judged for shape, so no page counts twice.
 * An input it cannot read counts in source_errors, and a lint that does not load writes 999999 for the metrics it feeds. The output's `n`
 * names how many pages or inputs each metric measured.
 */

export const UNMEASURED = 999_999;
/** The statuses the wiki lint reads as retired (apps/wiki wiki-lint.ts RETIRED_STATUSES). */
const RETIRED = new Set(["superseded", "deprecated", "archived", "retired"]);
/** A title that names its day, such as "Root free space 10-25", "2026-10-25" or "Oct 25": a one-off record of that day. */
const DATED_TITLE = /\b(?:20\d\d-)?(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b/;
const ONE_OFF_KINDS = new Set(["incident", "postmortem"]);
const LINT_URL = new URL("../../../../../apps/wiki/src/lib/prose-lint.mjs", import.meta.url).href;

export interface LintFinding { rule: string; severity: string; excerpt: string; line: number }
export type Lint = (html: string, opts: { path: string }) => { findings: LintFinding[] };
export type PageKind = "retired" | "one_off" | "off_shape";
export interface PageVerdict { page: string; kinds: PageKind[]; reasons: string[]; lintErrors: number }
export interface TidyDeps {
  content: string;
  listPages: () => Promise<string[]>;
  readText: (path: string) => Promise<string>;
  lint: () => Promise<Lint>;
}

const clip = (text: string, max = 600): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
export const inScope = (path: string): boolean => /^(?:apps|domains)\/.+\.html$/.test(path);

/**
 * A doc-paragraph finding counts only past these lines, because the lint's own 2 sentences or 50 words flagged pages that read fine.
 * measured: on 11-26 routing.html, llm-wiki/prior-art.html, kick.html and clickhouse-layout.html read fine with 3-sentence paragraphs of 55 to 59 words.
 */
export const WALL_SENTENCES = 3;
/** measured: the fine 11-26 samples peaked at 59 words, and the walls (debug-a-stuck-thread, egress, campaigns/funnel) ran 4-sentence paragraphs. */
export const WALL_WORDS = 80;
/** measured: on 11-26 lead prose of 36 to 66 words before the first visual read fine; the walls had 150+ (schema-change-rules 449, workers 289). */
export const LEAD_WALL_WORDS = 100;

const paragraphSize = (finding: LintFinding): { sentences: number; words: number } => {
  const match = /^(\d+) sentences, (\d+) words/.exec(finding.excerpt);
  return { sentences: Number(match?.[1] ?? 0), words: Number(match?.[2] ?? 0) };
};
const leadWords = (finding: LintFinding): number => Number(/\((\d+) words\)/.exec(finding.excerpt)?.[1] ?? 0);

/**
 * The lint errors that make a page a wall of text: a doc-paragraph past WALL_SENTENCES or WALL_WORDS, a lead-visual with LEAD_WALL_WORDS or
 * more before the first visual, and every other error, such as line-ref-in-prose, which the owner's c248 backs.
 */
export function wallFindings(findings: readonly LintFinding[]): LintFinding[] {
  return findings.filter(finding => {
    if (finding.severity !== "error") return false;
    if (finding.rule === "doc-paragraph") { const size = paragraphSize(finding); return size.sentences > WALL_SENTENCES || size.words > WALL_WORDS; }
    if (finding.rule === "lead-visual") return leadWords(finding) >= LEAD_WALL_WORDS;
    return true;
  });
}

/** The shape reasons of a page's wall findings, one per rule; doc-paragraph names each paragraph's line, sentences and words. */
export function shapeReasons(findings: readonly LintFinding[]): string[] {
  const byRule = new Map<string, LintFinding[]>();
  for (const finding of wallFindings(findings)) byRule.set(finding.rule, [...byRule.get(finding.rule) ?? [], finding]);
  return [...byRule].map(([rule, list]) => {
    if (rule === "doc-paragraph") {
      const each = list.map(finding => { const size = paragraphSize(finding); return `L${finding.line} ${size.sentences} sentences ${size.words} words`; });
      return `${list.length} paragraph${list.length > 1 ? "s" : ""} over ${WALL_SENTENCES} sentences or ${WALL_WORDS} words: ${each.join(", ")} (doc-paragraph)`;
    }
    if (rule === "lead-visual") return `${list[0]!.excerpt} (lead-visual)`;
    return `${list.length} ${rule} error${list.length > 1 ? "s" : ""}: ${list[0]!.excerpt}`;
  });
}

/** What a page needs, or null when it is tidy or is no page a reader sees (a moved page's redirect stub). */
export function judgePage(path: string, html: string, lint: Lint): PageVerdict | null {
  const header = pageHeader(html);
  if (typeof header.moved_to === "string") return null;
  const status = String(header.status ?? "").toLowerCase();
  const title = typeof header.title === "string" ? header.title : "";
  const kinds: PageKind[] = []; const reasons: string[] = [];
  if (RETIRED.has(status)) {
    kinds.push("retired");
    reasons.push(`status ${status}${typeof header.superseded_by === "string" ? ` (superseded_by ${header.superseded_by})` : ""}, still in the sidebar outside archive/`);
  }
  if (DATED_TITLE.test(title) || ONE_OFF_KINDS.has(String(header.kind))) {
    kinds.push("one_off");
    reasons.push(DATED_TITLE.test(title) ? `title "${title}" names a day, a one-off record` : `kind ${String(header.kind)}, a one-off record`);
  }
  let lintErrors = 0;
  if (!kinds.length) {
    const walls = wallFindings(lint(html, { path }).findings);
    lintErrors = walls.length;
    if (walls.length) { kinds.push("off_shape"); reasons.push(...shapeReasons(walls)); }
  }
  return kinds.length ? { page: path, kinds, reasons, lintErrors } : null;
}

/** Reads every live apps/ and domains/ page and builds the precheck output; `verdicts` keeps each flagged page with its kinds and reasons. */
export async function measureTidiness(deps: TidyDeps): Promise<PrecheckOutput & { info: Record<string, number>; n: Record<string, number>; verdicts: PageVerdict[] }> {
  const errors: FlaggedSlice[] = [];
  const fail = (source: string, error: unknown): undefined => {
    errors.push({ kind: "source_error", item: source, excerpt: clip(`${source}: ${error instanceof Error ? error.message : String(error)}`, 240) });
    return undefined;
  };
  const lint = await deps.lint().catch(error => fail("prose-lint.mjs", error));
  const paths = (await deps.listPages().catch(error => fail("wiki pages", error)))?.filter(inScope);
  const verdicts: PageVerdict[] = [];
  let read = 0, stubs = 0, lintErrors = 0, linted = 0;
  for (const path of lint && paths ? paths : []) {
    const html = await deps.readText(join(deps.content, path)).catch(error => fail(`read ${path}`, error));
    if (html === undefined) continue;
    read += 1;
    if (typeof pageHeader(html).moved_to === "string") { stubs += 1; continue; }
    const verdict = (() => { try { return judgePage(path, html, lint!); } catch (error) { return fail(`lint ${path}`, error) ?? null; } })();
    if (!verdict || verdict.kinds.includes("off_shape")) linted += 1;
    if (!verdict) continue;
    lintErrors += verdict.lintErrors;
    verdicts.push(verdict);
  }
  const measured = lint !== undefined && paths !== undefined;
  const retired = verdicts.filter(verdict => !verdict.kinds.includes("off_shape"));
  const offShape = verdicts.filter(verdict => verdict.kinds.includes("off_shape"));
  const metrics: Record<string, number> = {
    pages_needing_fix: measured ? verdicts.length : UNMEASURED,
    retired_pages_shown: measured ? retired.length : UNMEASURED,
    pages_off_shape: measured ? offShape.length : UNMEASURED,
    source_errors: errors.length,
  };
  const info: Record<string, number> = {
    pages_read: read, redirect_stubs: stubs, wall_errors: lintErrors,
    retired_status: verdicts.filter(verdict => verdict.kinds.includes("retired")).length,
    one_off: verdicts.filter(verdict => verdict.kinds.includes("one_off")).length,
  };
  /** What each metric measured, so a met run on no input never reads green (Agent factory d7 `sampleSize`, 11-26). */
  const live = read - stubs;
  const n: Record<string, number> = {
    pages_needing_fix: live, retired_pages_shown: live, pages_off_shape: linted, source_errors: 2 + (paths?.length ?? 0),
  };
  const ordered = [...retired.sort((a, b) => a.page.localeCompare(b.page)), ...offShape.sort((a, b) => b.lintErrors - a.lintErrors || a.page.localeCompare(b.page))];
  const flagged: FlaggedSlice[] = [...errors, ...ordered.map((verdict): FlaggedSlice => ({
    kind: verdict.kinds.includes("off_shape") ? "off_shape" : "retired_page", item: verdict.page, handOff: true,
    sig: `${verdict.kinds.join("+")}:${verdict.reasons.join("|")}`, excerpt: clip(`${verdict.kinds.join(", ")}: ${verdict.reasons.join("; ")}`),
  }))];
  return { metrics, flagged, info, n, verdicts: ordered };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("wiki-tidiness: OUTPUT_FILE is not set\n"); process.exit(2); }
  const content = wikiContentDir();
  const { verdicts: _verdicts, ...result } = await measureTidiness({
    content, listPages: () => listCuratedPages(content), readText: path => readFile(path, "utf8"),
    lint: async () => ((await import(LINT_URL)) as { lintHtml: Lint }).lintHtml,
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (result.metrics.pages_needing_fix === UNMEASURED) {
    const inputs = (result.flagged ?? []).filter(slice => slice.kind === "source_error").map(slice => slice.excerpt);
    process.stderr.write(`wiki-tidiness: could not measure: ${inputs.join("; ")}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

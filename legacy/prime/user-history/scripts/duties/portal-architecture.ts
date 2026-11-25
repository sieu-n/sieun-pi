import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { BASE } from "./apps-chat.ts";

/**
 * The api-portal agent's "Portal architecture" precheck (`node --import tsx scripts/duties/portal-architecture.ts`). No model call, reads only.
 * The owner asked in #dev-api-portal p23 (mwwhn4a3) "api portal 관련 테이블이랑 아케텍쳐 쭉 정리해봐 is it clean and follows our standard in
 * general?" and then (mwwk8mcw) "think of duty as copy pasting this prompt every day". Each duty run redoes that review, rewrites wiki
 * agents/api-portal/architecture.html and writes STATUS_FILE, one row per open standards problem with its severity. This script reads both:
 * high_problems_open counts the high rows (hurts customers, loses money or hides failures) that are not fixed on prod, review_age_h is the
 * hours since the older of the file's checkedAt and the page's last_verified, and problems_open counts every row not fixed.
 */

export const STATUS_FILE = process.env.PORTAL_ARCH_STATUS_FILE || join(homedir(), "work/api-portal/arch-review/status.json");
export const PAGE = "agents/api-portal/architecture.html";
/** The "could not measure" value the other api-portal prechecks print, so a missing source never reads on target. */
export const UNMEASURED = 999999;
/** A review this old is redone: a daily slot reads it about 24 h after the last run's review, a push run 2 h after reads it fresh. */
export const REVIEW_DUE_H = 20;

const SEVERITIES = ["high", "medium", "low"] as const;
const STATES = ["open", "fixing", "fixed"] as const;
type Severity = (typeof SEVERITIES)[number];
type State = (typeof STATES)[number];
export interface Problem { id: string; severity: Severity; status: State; title: string; where?: string; step?: string }
export interface Status { checkedAt: number; problems: Problem[] }

/** The status file's rows, or a thrown error naming the first row that breaks the shape. */
export function parseStatus(text: string): Status {
  const raw = JSON.parse(text) as { checkedAt?: unknown; problems?: unknown };
  const checkedAt = Date.parse(String(raw.checkedAt));
  if (Number.isNaN(checkedAt)) throw new Error("checkedAt is not an ISO time");
  if (!Array.isArray(raw.problems)) throw new Error("problems is not a list");
  const problems = raw.problems.map((row: Record<string, unknown>, index): Problem => {
    const { id, severity, status, title, where, step } = row ?? {};
    if (typeof id !== "string" || typeof title !== "string") throw new Error(`problem ${index} needs an id and a title`);
    if (!SEVERITIES.includes(severity as Severity)) throw new Error(`problem ${id} has severity ${String(severity)}`);
    if (!STATES.includes(status as State)) throw new Error(`problem ${id} has status ${String(status)}`);
    return { id, title, severity: severity as Severity, status: status as State,
      ...(typeof where === "string" ? { where } : {}), ...(typeof step === "string" ? { step } : {}) };
  });
  return { checkedAt, problems };
}

/** The page's last_verified front matter as epoch ms, or NaN when it has none. */
export const lastVerified = (markdown: string): number => Date.parse(/^last_verified:\s*"?([^"\n]+)"?\s*$/m.exec(markdown)?.[1] ?? "");

/**
 * The precheck output with `n`, what each duty metric read (agent factory's sampleSize in apps/chat/scripts/duties/agent-boards.ts): the
 * problem rows of STATUS_FILE, fixed ones included, for the two counts, and the two review times (checkedAt and last_verified) for the age.
 */
export type ArchitectureOutput = PrecheckOutput & { n: Record<string, number> };

export function report(status: Status, verifiedAt: number, now: number): ArchitectureOutput {
  const open = status.problems.filter(problem => problem.status !== "fixed");
  const high = open.filter(problem => problem.severity === "high");
  const reviewedAt = Number.isNaN(verifiedAt) ? Number.NaN : Math.min(status.checkedAt, verifiedAt);
  const ageH = Number.isNaN(reviewedAt) ? UNMEASURED : Math.round((now - reviewedAt) / 360_000) / 10;
  const flagged: FlaggedSlice[] = high.map(problem => ({
    kind: problem.step ? "high_fixing" : "high_unowned",
    ...(problem.step ? { item: problem.step } : {}),
    excerpt: `${problem.id}, ${problem.status}${problem.step ? `, step ${problem.step}` : ", no step"}: ${problem.title}` +
      `${problem.where ? ` at ${problem.where}` : ""}. Source ${STATUS_FILE}.`,
  }));
  // An item makes the run start its job even when every metric is met, because the owner asked for the review every day (mwwk8mcw); a push
  // run soon after a review reads under REVIEW_DUE_H and skips it.
  if (ageH >= REVIEW_DUE_H) flagged.push({ kind: "review_due", item: "daily-review", excerpt: `Redo the review: the last one is ${ageH} h old.` });
  if (ageH > 26) {
    flagged.push({ kind: "review_stale", excerpt: Number.isNaN(verifiedAt)
      ? `wiki ${PAGE} has no last_verified line. Source ${STATUS_FILE}.`
      : `The review is ${ageH} h old: ${STATUS_FILE} checkedAt ${new Date(status.checkedAt).toISOString()}, wiki ${PAGE} last_verified ${new Date(verifiedAt).toISOString()}.` });
  }
  const counts = SEVERITIES.map(severity => `${open.filter(problem => problem.severity === severity).length} ${severity}`).join(", ");
  const empty = status.problems.length ? "" : " The file lists no problem rows, so both problem counts read 0 rows and measured nothing.";
  flagged.push({ kind: "summary", excerpt: `${open.length} open problems (${counts}) in ${STATUS_FILE}; page ${PAGE}.${empty}` });
  const rows = status.problems.length;
  return { metrics: { high_problems_open: high.length, review_age_h: ageH, problems_open: open.length }, flagged,
    n: { high_problems_open: rows, review_age_h: ageH === UNMEASURED ? 0 : 2, problems_open: rows } };
}

export async function measure(now: number, send: typeof fetch = fetch): Promise<ArchitectureOutput> {
  try {
    const status = parseStatus(await readFile(STATUS_FILE, "utf8"));
    const response = await send(`${BASE}/wiki/${PAGE}?format=md`, { headers: { accept: "text/markdown" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GET ${BASE}/wiki/${PAGE} answered ${response.status}`);
    return report(status, lastVerified(await response.text()), now);
  } catch (error) {
    return { metrics: { high_problems_open: UNMEASURED, review_age_h: UNMEASURED, problems_open: UNMEASURED },
      n: { high_problems_open: 0, review_age_h: 0, problems_open: 0 },
      flagged: [{ kind: "source_error", excerpt: `${error instanceof Error ? error.message : String(error)} (status ${STATUS_FILE}, page ${PAGE})` }] };
  }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-architecture: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measure(Date.now()), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();

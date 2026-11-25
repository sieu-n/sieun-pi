import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The 5180 parity duty's precheck for the agent 5180 designer, run on the owner's Mac (demo-parity-box.ts runs it there over `ssh mac`).
 * The owner asked in #search-design p3 on 11-25: "is 5180 5174 staging prod in parity? 지금 온보딩 등등 개선하고 싶은데 어디서부터 봐야 해?"
 * Prod, staging and 5174 run the same apps/search code, so parity is a question about 5180. Its judged metrics:
 * - pin_behind_h, the headline: hours since the oldest origin/staging commit that touches apps/search or convex/ and that the pin 5180 runs
 *   lacks, 0 when it lacks none. The pin is the one `/__demo/health` names, else the committed apps/virev-demo/PIN when 5180 does not answer.
 * - onboarding_problems: problems in the last parity walk of onboarding end to end on 5180 and on staging.virev.ai, plus 1 while the walk is
 *   missing or older than WALK_STALE_MS.
 * - shipped_differences: open differences between 5180's Shipped line and staging on onboarding and Home in the last parity walk, plus 1
 *   while the walk is missing or older than WALK_STALE_MS.
 * The walk is a headful aside-browser walk that the duty's job runs and saves to WALK_FILE. This script never opens a browser. It hands the
 * job a `walk_due` item whenever the walk is older than WALK_DUE_MS or was taken on another pin, so each daily run reruns the owner's ask.
 * Run detail, not judged: commits_behind (apps/search and convex/ staging commits the pin lacks) and walk_age_h.
 */

const run = promisify(execFile);

export const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const WALK_FILE = process.env.PARITY_WALK_FILE || join(homedir(), ".pi/agent/agents/5180-designer/work/duties/parity-walk.json");
export const DEMO_HEALTH_URL = "http://localhost:5180/__demo/health";
/** The paths whose staging commits 5180 takes through its pin (apps/virev-demo/scripts/materialize.mjs copies apps/search and convex/). */
export const PIN_PATHS = ["apps/search", "convex"];
/** The duty runs once a day, so a walk from an earlier day's run is due again; 20 h stays under the 24 h between two daily runs. */
export const WALK_DUE_MS = 20 * 60 * 60_000;
/** A walk older than two daily runs means a run's walk failed or never ran, so it counts 1 on both walk metrics. */
export const WALK_STALE_MS = 48 * 60 * 60_000;
/** How long the health read waits: the 30 s every 5180 health check uses (demo-sandbox.ts ANSWER_TIMEOUT_MS). */
const ANSWER_TIMEOUT_MS = 30_000;

export interface WalkProblem { env: string; step: string; what: string; shot?: string }
export interface WalkDifference { screen: string; what: string; shot5180?: string; shotStaging?: string }
/** What the duty job writes to WALK_FILE after each walk. */
export interface ParityWalk { at: string; pin: string; staging: string; onboardingProblems: WalkProblem[]; shippedDifferences: WalkDifference[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** The walk file's contents, or an error naming the first field that is wrong. */
export function parseWalk(value: unknown): ParityWalk {
  if (!isRecord(value)) throw new Error("the walk file is not a JSON object");
  const { at, pin, staging, onboardingProblems, shippedDifferences } = value;
  if (!text(at) || Number.isNaN(Date.parse(at))) throw new Error("at: an ISO time");
  if (!text(pin) || !text(staging)) throw new Error("pin and staging: the shas 5180 and staging.virev.ai ran");
  if (!Array.isArray(onboardingProblems) || !onboardingProblems.every(item => isRecord(item) && text(item.env) && text(item.step) && text(item.what)))
    throw new Error("onboardingProblems: a list of { env, step, what, shot? }");
  if (!Array.isArray(shippedDifferences) || !shippedDifferences.every(item => isRecord(item) && text(item.screen) && text(item.what)))
    throw new Error("shippedDifferences: a list of { screen, what, shot5180?, shotStaging? }");
  return { at, pin, staging, onboardingProblems: onboardingProblems as WalkProblem[], shippedDifferences: shippedDifferences as WalkDifference[] };
}

/** The walk metrics and items for a walk read at `now` against the pin 5180 runs (`livePin`, a full sha). */
export function walkReading(walk: ParityWalk | null, livePin: string, now: number): { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  if (!walk) {
    return { metrics: { onboarding_problems: 1, shipped_differences: 1 }, flagged: [{ at: now, kind: "walk_due", handOff: true,
      excerpt: `no parity walk saved at ${WALK_FILE} yet, so each walk metric reads 1; run the walk this duty's onMiss names and save it there` }] };
  }
  const age = now - Date.parse(walk.at);
  const stale = age > WALK_STALE_MS ? 1 : 0;
  const metrics = { onboarding_problems: walk.onboardingProblems.length + stale, shipped_differences: walk.shippedDifferences.length + stale,
    walk_age_h: Math.round(age / 360_000) / 10 };
  const flagged: FlaggedSlice[] = [
    ...walk.onboardingProblems.map(item => ({ at: Date.parse(walk.at), kind: "onboarding_problem", excerpt: `${item.env}, ${item.step}: ${item.what}${item.shot ? ` (${item.shot})` : ""}` })),
    ...walk.shippedDifferences.map(item => ({ at: Date.parse(walk.at), kind: "shipped_difference", excerpt: `${item.screen}: ${item.what}` })),
  ];
  const otherPin = !livePin.startsWith(walk.pin) && !walk.pin.startsWith(livePin.slice(0, walk.pin.length));
  if (age > WALK_DUE_MS || otherPin) {
    const why = [age > WALK_DUE_MS ? `${metrics.walk_age_h} h old` : "", otherPin ? `taken on pin ${walk.pin} while 5180 runs ${livePin.slice(0, 10)}` : ""]
      .filter(Boolean).join(" and ");
    flagged.push({ at: now, kind: "walk_due", handOff: true, excerpt: `the last parity walk is ${why}; walk again and save it to ${WALK_FILE}` });
  }
  return { metrics, flagged };
}

async function git(...args: string[]): Promise<string> {
  return (await run("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

/** The pin 5180 serves by its health answer, or the committed PIN with a `demo_down` item when 5180 does not answer. */
async function livePin(now: number): Promise<{ pin: string; flagged: FlaggedSlice[] }> {
  const committed = await git("show", "HEAD:apps/virev-demo/PIN");
  try {
    const response = await fetch(DEMO_HEALTH_URL, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    const health = await response.json() as { pin?: unknown };
    if (!response.ok || !text(health.pin)) throw new Error(`answered ${response.status} with no pin`);
    const pin = await git("rev-parse", "--verify", `${health.pin}^{commit}`);
    const flagged: FlaggedSlice[] = pin === committed ? [] : [{ at: now, kind: "pin_not_live", excerpt: `5180 serves pin ${pin.slice(0, 10)} while the ` +
      `committed apps/virev-demo/PIN is ${committed.slice(0, 10)}, so 5180 has not restarted onto the last pin move; tell 5180 port metal` }];
    return { pin, flagged };
  } catch (error) {
    return { pin: committed, flagged: [{ at: now, kind: "demo_down", excerpt: `${DEMO_HEALTH_URL} gave no pin (${error instanceof Error ? error.message : String(error)}), ` +
      `so pin_behind_h reads the committed PIN ${committed.slice(0, 10)}; frontend bro's d1 owns keeping 5180 up` }] };
  }
}

/** How far the pin trails origin/staging on PIN_PATHS, from the Mac checkout's origin/staging, which its take-in fetches every 5 minutes. */
async function pinLag(pin: string, now: number): Promise<{ metrics: Record<string, number>; flagged: FlaggedSlice[] }> {
  const local = await git("rev-parse", "origin/staging");
  const remote = (await run("git", ["-C", REPO, "ls-remote", "origin", "refs/heads/staging"], { encoding: "utf8" })).stdout.split(/\s/)[0] ?? "";
  const flagged: FlaggedSlice[] = [];
  if (remote && remote !== local) {
    flagged.push({ at: now, kind: "staging_ref_behind", excerpt: `the Mac's origin/staging is ${local.slice(0, 10)} while GitHub's staging is ` +
      `${remote.slice(0, 10)}, so pin_behind_h may read low; the Mac take-in (ai.virev.mac-take-in) fetches it` });
  }
  const missing = (await git("rev-list", "--reverse", "--format=%ct", `${pin}..origin/staging`, "--", ...PIN_PATHS))
    .split("\n").filter(line => /^\d+$/.test(line)).map(Number);
  const oldest = missing[0];
  const hours = oldest === undefined ? 0 : Math.round((now / 1000 - oldest) / 360) / 10;
  if (oldest !== undefined) {
    flagged.push({ at: now, kind: "pin_behind", excerpt: `5180's pin ${pin.slice(0, 10)} lacks ${missing.length} apps/search and convex staging ` +
      `commits up to ${local.slice(0, 10)}, the oldest landed ${hours} h ago` });
  }
  return { metrics: { pin_behind_h: hours, commits_behind: missing.length }, flagged };
}

async function readWalk(): Promise<ParityWalk | null> {
  const exists = await stat(WALK_FILE).then(() => true, () => false);
  return exists ? parseWalk(JSON.parse(await readFile(WALK_FILE, "utf8"))) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Date.now();
  const live = await livePin(now);
  const lag = await pinLag(live.pin, now);
  const walk = walkReading(await readWalk(), live.pin, now);
  const output: PrecheckOutput = { metrics: { ...lag.metrics, ...walk.metrics }, flagged: [...live.flagged, ...lag.flagged, ...walk.flagged] };
  const json = JSON.stringify(output);
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}

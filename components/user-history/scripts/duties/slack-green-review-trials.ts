import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { reason as fetchReason } from "../../src/usage/lgtm.ts";
import { parseEnv } from "./local-dev-uptime.ts";

/**
 * The slack green guy's Reviewers get trials duty's precheck (`node --import tsx scripts/duties/slack-green-review-trials.ts`). No model call.
 * It reads prod Supabase (PostgREST, GET only) for review posts (threads with type review) that have no trial decision
 * (trial_extension_days is null), skips the owner's two test posts, and lists each waiting post with the poster's subscription for the duty
 * job. It never grants a trial, writes a row, downloads a screenshot or emails anyone. The service key comes from slack-green's
 * scripts/seo-agent/.env (gitignored), read as a file; no slack-green code runs.
 */

const REPO = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");
const DEFAULT_URL = "https://pcpcicvhrcazmlpjrqho.supabase.co";
/**
 * A post waits too long after 24 h: the owner asked for a "daily check for the review", so a run once a day sees each post within 24 h.
 * The duty JSON's targets (JSON has no comments): reviews_waiting_24h <= 0 because every real post gets a decision, and source_errors <= 0
 * because an unread source is a miss. The JSON sets no precheck timeoutMs, so the runner's PRECHECK_TARGET_MS (120 s) applies; the first
 * run took 2.6 s. The onMiss grant of 14 days matches the past grants: 15 of the 18 granted posts in prod got 14 days (read 2026-10-12).
 */
export const WAIT_MS = 24 * 60 * 60_000;
/** The owner's own test posts (thread id prefixes): "This is a test :)" on 2025-12-26 and the 2026-02-18 note with no user. */
export const SKIP = ["601e7118", "684a952b"] as const;

export interface ReviewThread { id: string; created_at: string; user_id: string | null; trial_extension_days: number | null; rating: number | null; content: string | null; image_url: string | null }
export interface Subscription { user_id: string; plan_type: string | null; status: string | null; trial_ends_at: string | null }
export interface ReviewDeps { fetch: typeof fetch; now: () => number; url: string; key: string }

/** The posts that still wait for a trial decision, test posts left out, and the ones of them older than WAIT_MS. */
export function waiting(threads: readonly ReviewThread[], now: number): { open: ReviewThread[]; late: ReviewThread[] } {
  const open = threads.filter(thread => thread.trial_extension_days === null && !SKIP.some(prefix => thread.id.startsWith(prefix)));
  return { open, late: open.filter(thread => now - Date.parse(thread.created_at) > WAIT_MS) };
}

/** The flagged slice for one waiting post: what the job needs to judge it, with the screenshot URL instead of the image. */
export function slice(thread: ReviewThread, subscription: Subscription | undefined, now: number): FlaggedSlice {
  const hours = Math.floor((now - Date.parse(thread.created_at)) / 3_600_000);
  const plan = subscription ? `plan ${subscription.plan_type ?? "?"} (${subscription.status ?? "?"}), trial ends ${subscription.trial_ends_at ?? "never set"}` : "no subscription row";
  const text = (thread.content ?? "").replace(/\s+/g, " ").trim();
  return { at: Date.parse(thread.created_at), kind: now - Date.parse(thread.created_at) > WAIT_MS ? "waiting" : "new", item: "p48",
    excerpt: `review ${thread.id} posted ${thread.created_at} (${hours} h ago) by user ${thread.user_id ?? "none"}, rating ${thread.rating ?? "none"}, ${plan}; ` +
      `text "${text}"; screenshot ${thread.image_url ?? "none"}` };
}

/**
 * One GET, tried a second time right away when fetch itself throws (a network error; an HTTP error status is an answer and is never retried).
 * On 10-27 at 14:36Z the read failed with "fetch failed" while the box's DNS answered EAI_AGAIN, and a rerun at 14:42Z read fine. That
 * outage ran 15 min (14:27:30Z to 14:42:30Z, see src/uplink-dark.ts), far past the 120 s precheck target, so no wait inside one run would
 * have bridged it; the retry is immediate and covers only a single dropped lookup or connection. The thrown text names the undici cause.
 */
async function get<T>(deps: ReviewDeps, path: string, params: Record<string, string>): Promise<T> {
  const url = `${deps.url}/rest/v1/${path}?${new URLSearchParams(params)}`;
  const init = { headers: { apikey: deps.key, Authorization: `Bearer ${deps.key}` } };
  let response: Response;
  try { response = await deps.fetch(url, init); }
  catch (first) {
    try { response = await deps.fetch(url, init); }
    catch (second) { throw new Error(`GET ${path} failed twice: ${fetchReason(second)}; first try ${fetchReason(first)}`); }
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${path} gave HTTP ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export async function measureReviews(deps: ReviewDeps): Promise<{ output: PrecheckOutput }> {
  const at = deps.now();
  const metrics: Record<string, number> = { reviews_waiting_24h: 0, source_errors: 0 };
  const flagged: FlaggedSlice[] = [];
  if (!deps.key) {
    metrics.source_errors = 1;
    flagged.push({ at, kind: "source_error", item: "p48", excerpt: `SUPABASE_SERVICE_KEY is not set in ${REPO}/scripts/seo-agent/.env, so no review post was read` });
    return { output: { metrics, flagged } };
  }
  let threads: ReviewThread[];
  try {
    threads = await get<ReviewThread[]>(deps, "threads", { type: "eq.review", select: "id,created_at,user_id,trial_extension_days,rating,content,image_url", order: "created_at.desc" });
  } catch (error) {
    metrics.source_errors = 1;
    flagged.push({ at, kind: "source_error", item: "p48", excerpt: `prod Supabase threads read failed: ${error instanceof Error ? error.message : String(error)}` });
    return { output: { metrics, flagged } };
  }
  const { open, late } = waiting(threads, at);
  metrics.reviews_waiting_24h = late.length;
  const users = [...new Set(open.map(thread => thread.user_id).filter((id): id is string => !!id))];
  let subscriptions: Subscription[] = [];
  if (users.length) {
    try { subscriptions = await get<Subscription[]>(deps, "subscriptions", { user_id: `in.(${users.join(",")})`, select: "user_id,plan_type,status,trial_ends_at" }); }
    catch (error) {
      metrics.source_errors = 1;
      flagged.push({ at, kind: "source_error", item: "p48", excerpt: `prod Supabase subscriptions read failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  for (const thread of open) flagged.push(slice(thread, subscriptions.find(row => row.user_id === thread.user_id), at));
  const latest = threads.find(thread => !SKIP.some(prefix => thread.id.startsWith(prefix)));
  flagged.push({ at, kind: "summary", item: "p48", excerpt: `${threads.length} review posts in prod, ${open.length} with no trial decision (${late.length} older than 24 h), ` +
    `test posts ${SKIP.join(" and ")} skipped; newest real post ${latest ? latest.created_at : "none"}` });
  return { output: { metrics, flagged } };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-review-trials: OUTPUT_FILE is not set\n"); process.exit(2); }
  const env = await readFile(join(REPO, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({} as Record<string, string>));
  const url = (env.SUPABASE_URL || env.SUPABASE_STORAGE_URL || DEFAULT_URL).replace(/\/+$/, "");
  const result = await measureReviews({ fetch, now: Date.now, url, key: env.SUPABASE_SERVICE_KEY ?? "" });
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

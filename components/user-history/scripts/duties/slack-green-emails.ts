import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";
import { parseEnv } from "./local-dev-uptime.ts";

/**
 * The slack green guy's Slack green emails duty's precheck (`node --import tsx scripts/duties/slack-green-emails.ts`). No model call.
 * It reads every email Slack Green sent through Resend (the team's whole send log, GET /emails, slack.green senders only; the same Resend team
 * also sends Virev mail) and matches each recipient to prod Supabase: the account, its soft delete (profiles.email "DELETED_<iso>_..."), its
 * first Slack workspace and its marketing opt-out. All reads; it sends nothing and writes no row.
 * The Resend key is RESEND_API_KEY when set, else the Railway variable of slack-green-backend production (the repo's .env*.secret files are
 * git-secret encrypted). The same Railway link lists the backend deploys, to say whether the #233 token email removal is live.
 * The Supabase SQL goes through the Management API with read_only true and SUPABASE_ACCESS_TOKEN from slack-green's scripts/seo-agent/.env.
 */

const REPO = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");
const PROJECT = "pcpcicvhrcazmlpjrqho";
export const DAY_MS = 24 * 60 * 60_000;
/**
 * The duty JSON's targets and where each comes from (JSON has no comments):
 * - bad_sends_24h <= 0 is the headline: the owner asked that no false-positive or annoying email goes out (2026-10-14). It counts each send in
 *   the last 24 h that is a false positive or annoying, once, plus 1 for each data source that failed, since an unread source cannot show a clean day.
 * - false_positive_sends <= 0 and annoying_sends_24h <= 0 split the headline into his two words. Annoying is a repeat of the same email within
 *   24 h or a connect nudge past NUDGE_CAP for that person, sent in the last 24 h.
 * - users_over_cap (the whole Resend log), repeat_sends_24h, unsubscribes_24h and source_errors are run detail: written to the output, not judged.
 * - users_over_cap counts connect nudges above NUDGE_CAP. PR #247 (packages/frontend/src/lib/setup-link-email.ts) sets MAX_SETUP_EMAILS = 2
 *   for the setup link and the 24 h connect reminder together.
 * - bounce_or_complaint_pct <= 4: Resend's warm-up guide (https://resend.com/docs/knowledge-base/warming-up.md) says to keep the bounce rate
 *   below 4% and the spam rate below 0.08%. One rate holds both, so every complaint is also listed on its own.
 * The JSON sets no precheck timeoutMs, so the runner's PRECHECK_TARGET_MS (120 s) applies.
 */
export const NUDGE_CAP = 2;
/** PR #233 (4222b4b) removed the token expired email; it merged at this time. A token email after it is one the owner already turned down. */
export const TOKEN_EMAIL_REMOVED_AT = Date.parse("2026-10-14T01:22:18Z");

export type Template = "connect_reminder" | "setup_link" | "token_expired" | "trial_d7" | "trial_d2" | "trial_d0" | "trial_followup" |
  "signup_confirm" | "password_reset" | "other";
/**
 * Subjects as sent today: the connect reminder from PR #225, the setup link from the onboarding route, the rest from the Resend log.
 * PR #285 gave the setup link a subject naming the saved workspace and hours, and added SETUP_EMAIL_PERSONAL_COPY subjects that the setup link
 * and the 24 h reminder share word for word. A personal subject counts as setup_link: both are nudges, so the connected check and the nudge cap
 * still see it, but a personal reminder to an opted-out user would not show as marketing. The flag was unset on Railway on 2026-10-20.
 */
const SUBJECTS: [Template, RegExp][] = [
  ["connect_reminder", /^Connect Slack to finish setting up Slack Green$/],
  ["setup_link", /^Finish your Slack Green setup on a computer$/],
  ["setup_link", / stays green .+ after one more step$/],
  ["setup_link", /^Open this on your laptop to connect /],
  ["setup_link", /^Connect Slack to keep .+ green$/],
  ["token_expired", /^Action needed: .+ needs updated tokens$/],
  ["trial_d7", /Trial Ends in a Week/],
  ["trial_d2", /Trial Ends Soon/],
  ["trial_d0", /Trial Has Ended/],
  ["trial_followup", /^50% Off Your First Month/],
  ["signup_confirm", /^Confirm Your Signup$/],
  ["password_reset", /^Reset Your Password$/],
];
export const NUDGES: readonly Template[] = ["connect_reminder", "setup_link"];
/** Sends the person asked for themselves (a signup or a reset); a second one in a day is their retry, not us. */
const ASKED: readonly Template[] = ["signup_confirm", "password_reset"];
/** Sends that should_send_marketing gates in packages/backend/app/lib/email.py: off for a user who turned marketing email off. */
const MARKETING: readonly Template[] = ["connect_reminder", "trial_d7", "trial_d2", "trial_d0", "trial_followup"];
const BAD_EVENTS = ["bounced", "complained"];
/** QA sign-in accounts, the same pattern as QA_EMAIL in PR #225's packages/backend/app/lib/email.py; our own test sends are left out. */
const QA_EMAIL = /^(sg-qa-[^@]*@slack\.green|qa\+[^@]*@example\.com|[^@]*\+sgqa[^@]*@.*)$/;

export const templateOf = (subject: string): Template => SUBJECTS.find(([, pattern]) => pattern.test(subject))?.[0] ?? "other";

export interface Send { id: string; at: number; to: string; template: Template; subject: string; lastEvent: string }
/** The account behind an address: user id, when it was soft-deleted, and when its first Slack workspace still on file was added. */
export interface Recipient { userId: string; deletedAt?: number; firstWorkspaceAt?: number }
export interface Deploys { live?: { at: number; commit: string }; sinceRemoval: string[] }
export interface EmailState { at: number; optedOut: string[] }
export interface Sources { sends?: Send[] | undefined; recipients?: Record<string, Recipient> | undefined; optedOut?: string[] | undefined; deploys?: Deploys; errors: string[] }

const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
/** Who got it, never the address: the user id, or a short hash when no account has the address. */
const who = (send: Send, recipients: Record<string, Recipient>): string =>
  recipients[send.to]?.userId ?? `address ${createHash("sha256").update(send.to).digest("hex").slice(0, 10)} (no account)`;

/** Why a send in the window should not have gone out, or null. `previous` is the last run's opt-out list, for marketing sends after it. */
export function wrongSend(send: Send, recipient: Recipient | undefined, previous: EmailState | undefined): string | null {
  if (!recipient) return ASKED.includes(send.template) ? null : "no account has this address";
  if (recipient.deletedAt !== undefined && recipient.deletedAt < send.at) return `the account was deleted at ${iso(recipient.deletedAt)}`;
  if (NUDGES.includes(send.template) && recipient.firstWorkspaceAt !== undefined && recipient.firstWorkspaceAt < send.at)
    return `the user connected a Slack workspace at ${iso(recipient.firstWorkspaceAt)}`;
  if (send.template === "token_expired" && send.at > TOKEN_EMAIL_REMOVED_AT) return `PR #233 removed this email at ${iso(TOKEN_EMAIL_REMOVED_AT)}`;
  if (MARKETING.includes(send.template) && previous && send.at > previous.at && previous.optedOut.includes(recipient.userId))
    return `the user had turned marketing email off by ${iso(previous.at)}`;
  return null;
}

export function emailMetrics(sources: Sources, now: number, previous: EmailState | undefined): { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  const metrics: Record<string, number> = { bad_sends_24h: 0, false_positive_sends: 0, annoying_sends_24h: 0, bounce_or_complaint_pct: 0,
    users_over_cap: 0, repeat_sends_24h: 0, unsubscribes_24h: 0, source_errors: sources.errors.length };
  const wrong = new Set<Send>();
  const annoying = new Set<Send>();
  const flagged: FlaggedSlice[] = sources.errors.map(excerpt => ({ at: now, kind: "source_error", excerpt, item: "p68" }));
  const recipients = sources.recipients ?? {};
  const all = (sources.sends ?? []).filter(send => !QA_EMAIL.test(send.to));
  const qa = (sources.sends ?? []).filter(send => send.at > now - DAY_MS && QA_EMAIL.test(send.to)).length;
  const day = all.filter(send => send.at > now - DAY_MS);
  if (sources.sends) {
    const counts = new Map<Template, number>();
    for (const send of day) counts.set(send.template, (counts.get(send.template) ?? 0) + 1);
    flagged.push({ at: now, kind: "sends_24h", item: "p68", excerpt: `${day.length} Slack Green emails in the last 24 h` +
      (counts.size ? `: ${[...counts].map(([template, count]) => `${template} ${count}`).join(", ")}` : "") + (qa ? ` (${qa} QA sends left out)` : "") +
      `; Resend's log reaches back to ${all.length ? iso(Math.min(...all.map(send => send.at))) : "nothing"} (${all.length} sends)` });
    for (const subject of new Set(day.filter(send => send.template === "other").map(send => send.subject)))
      flagged.push({ at: now, kind: "new_template", item: "p68", excerpt: `an email this precheck does not know went out: "${subject}"; add its subject to SUBJECTS and check who should get it` });
  }
  if (sources.sends && sources.recipients) {
    for (const send of day) {
      const why = wrongSend(send, recipients[send.to], previous);
      if (!why) continue;
      wrong.add(send);
      flagged.push({ at: send.at, kind: "false_positive", item: "p68", excerpt: `${send.template} to user ${who(send, recipients)} at ${iso(send.at)} (Resend ${send.id}): ${why}` });
    }
    const nudges = new Map<string, Send[]>();
    for (const send of all.filter(send => NUDGES.includes(send.template))) nudges.set(send.to, [...nudges.get(send.to) ?? [], send]);
    for (const sends of nudges.values()) {
      if (sends.length <= NUDGE_CAP) continue;
      metrics.users_over_cap! += 1;
      for (const extra of [...sends].sort((a, b) => a.at - b.at).slice(NUDGE_CAP)) if (extra.at > now - DAY_MS) annoying.add(extra);
      flagged.push({ at: sends[0]!.at, kind: "over_cap", item: "p68", excerpt: `user ${who(sends[0]!, recipients)} got ${sends.length} connect nudges ` +
        `(${sends.map(send => `${send.template} ${iso(send.at)}`).join(", ")}), over the cap of ${NUDGE_CAP}` });
    }
    const groups = new Map<string, Send[]>();
    for (const send of day.filter(send => !ASKED.includes(send.template))) groups.set(`${send.template} ${send.to}`, [...groups.get(`${send.template} ${send.to}`) ?? [], send]);
    for (const sends of groups.values()) {
      if (sends.length < 2) continue;
      metrics.repeat_sends_24h! += sends.length - 1;
      for (const extra of [...sends].sort((a, b) => a.at - b.at).slice(1)) annoying.add(extra);
      flagged.push({ at: sends[0]!.at, kind: "repeat", item: "p68", excerpt: `${sends[0]!.template} went to user ${who(sends[0]!, recipients)} ${sends.length} times in 24 h ` +
        `(${sends.map(send => iso(send.at)).join(", ")})` });
    }
    metrics.false_positive_sends = wrong.size;
    metrics.annoying_sends_24h = annoying.size;
  }
  metrics.bad_sends_24h = new Set([...wrong, ...annoying]).size + sources.errors.length;
  if (sources.sends) {
    const bad = day.filter(send => BAD_EVENTS.includes(send.lastEvent));
    metrics.bounce_or_complaint_pct = day.length ? Math.round(10000 * bad.length / day.length) / 100 : 0;
    for (const send of day.filter(send => [...BAD_EVENTS, "suppressed", "failed"].includes(send.lastEvent)))
      flagged.push({ at: send.at, kind: send.lastEvent, item: "p68", excerpt: `${send.template} to user ${who(send, recipients)} at ${iso(send.at)} (Resend ${send.id}) ended ${send.lastEvent}` });
  }
  if (sources.optedOut) {
    if (!previous) flagged.push({ at: now, kind: "baseline", item: "p68", excerpt: `first run: ${sources.optedOut.length} users have marketing email off; the next run counts new opt-outs against this list` });
    else {
      const fresh = sources.optedOut.filter(id => !previous.optedOut.includes(id));
      metrics.unsubscribes_24h = fresh.length;
      if (fresh.length) flagged.push({ at: now, kind: "unsubscribe", item: "p68", excerpt: `turned marketing email off since ${iso(previous.at)}: users ${fresh.join(", ")}` });
    }
  }
  // Once the live backend deploy is newer than #233 the removal is live, and a later token_expired send already counts as a wrong send above.
  if (sources.deploys && !(sources.deploys.live && sources.deploys.live.at > TOKEN_EMAIL_REMOVED_AT)) {
    const { live, sinceRemoval } = sources.deploys;
    flagged.push({ at: now, kind: "token_email_removal", item: "p68", excerpt: `#233 merged ${iso(TOKEN_EMAIL_REMOVED_AT)}; Railway deploys of main since then: ` +
      `${sinceRemoval.length ? sinceRemoval.join("; ") : "none"}; the live backend deploy is ${live ? `${live.commit.slice(0, 7)} from ${iso(live.at)}` : "unknown"}` });
  }
  return { metrics, flagged };
}

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<string>;
export interface EmailDeps { exec: Exec; fetch: typeof fetch; now: () => number; env: Record<string, string>; resendKey?: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/re_[A-Za-z0-9_]+|sbp_[A-Za-z0-9]+/g, "***");
const resendTime = (value: string): number => Date.parse(value.replace(" ", "T").replace(/\+00$/, "Z"));

interface ResendEmail { id: string; to: string[] | null; from: string; created_at: string; subject: string; last_event: string | null }

/**
 * Every Slack Green send in Resend's log, newest first, one page of 100 at a time. The log went back 30 days on 2026-10-14 (1,054 sends in
 * 11 pages, read in 0.4 s), well under Resend's default 10 requests per second (https://resend.com/docs/api-reference/rate-limit.md).
 */
export async function readSends(deps: EmailDeps, key: string): Promise<Send[]> {
  const sends: Send[] = [];
  let after: string | undefined;
  let more = true;
  while (more) {
    const response = await deps.fetch(`https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ""}`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await response.text();
    if (!response.ok) throw new Error(`Resend GET /emails gave HTTP ${response.status}: ${body.slice(0, 200)}`);
    const list = JSON.parse(body) as { has_more?: boolean; data: ResendEmail[] };
    for (const email of list.data) {
      if (!/@([a-z0-9-]+\.)*slack\.green>?$/i.test(email.from.trim())) continue;
      for (const to of email.to ?? []) sends.push({ id: email.id, at: resendTime(email.created_at), to: to.trim().toLowerCase(), template: templateOf(email.subject),
        subject: email.subject, lastEvent: email.last_event ?? "unknown" });
    }
    more = Boolean(list.has_more && list.data.length);
    after = list.data.at(-1)?.id;
  }
  return sends;
}

async function query<T>(deps: EmailDeps, sql: string): Promise<T[]> {
  const token = deps.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error(`SUPABASE_ACCESS_TOKEN is not set in ${REPO}/scripts/seo-agent/.env`);
  const response = await deps.fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql, read_only: true }) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase SQL gave HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T[];
}

/** The account behind each address. A soft-deleted profile keeps the address in auth.users and gets profiles.email "DELETED_<iso>_<address>". */
export async function readRecipients(deps: EmailDeps, addresses: string[]): Promise<Record<string, Recipient>> {
  const list = JSON.stringify([...new Set(addresses)]);
  if (list.includes("$sg$")) throw new Error("an address holds the SQL quote tag $sg$");
  const rows = await query<{ address: string; user_id: string | null; profile_email: string | null; first_ws: string | null }>(deps,
    `select a.address, u.id user_id, p.email profile_email, (select min(w.created_at) from slack_workspaces w where w.user_id = u.id) first_ws ` +
    `from (select distinct lower(value) address from jsonb_array_elements_text($sg$${list}$sg$::jsonb)) a ` +
    `left join auth.users u on lower(u.email) = a.address left join profiles p on p.id = u.id`);
  const recipients: Record<string, Recipient> = {};
  for (const row of rows) {
    if (!row.user_id) continue;
    const deleted = /^DELETED_([^_]+)_/.exec(row.profile_email ?? "")?.[1];
    recipients[row.address] = { userId: row.user_id, ...(deleted ? { deletedAt: Date.parse(deleted) } : {}),
      ...(row.first_ws ? { firstWorkspaceAt: Date.parse(row.first_ws) } : {}) };
  }
  return recipients;
}

interface RailwayDeploy { status: string; createdAt: string; meta?: { branch?: string; commitHash?: string; skippedReason?: string } }

/** The Resend key and the backend deploys from Railway, linked in a temp folder and unlinked after. */
export async function readRailway(deps: EmailDeps): Promise<{ key: string | undefined; deploys: Deploys }> {
  const dir = await mkdtemp(join(tmpdir(), "sg-emails-"));
  try {
    await deps.exec("railway", ["link", "--project", "slack-green-backend", "--environment", "production", "--service", "slack-green-backend"], { cwd: dir });
    const key = deps.resendKey || parseEnv(await deps.exec("railway", ["variable", "list", "--kv"], { cwd: dir })).RESEND_API_KEY;
    const list = await deps.exec("railway", ["deployment", "list", "--json", "--limit", "30"], { cwd: dir });
    const deploys = JSON.parse(list.slice(list.indexOf("["))) as RailwayDeploy[];
    const live = deploys.find(deploy => deploy.status === "SUCCESS");
    return { key, deploys: { ...(live ? { live: { at: Date.parse(live.createdAt), commit: live.meta?.commitHash ?? "?" } } : {}),
      sinceRemoval: deploys.filter(deploy => Date.parse(deploy.createdAt) >= TOKEN_EMAIL_REMOVED_AT && deploy.meta?.branch === "main")
        .map(deploy => `${(deploy.meta?.commitHash ?? "?").slice(0, 7)} ${deploy.status}${deploy.meta?.skippedReason ? ` (${deploy.meta.skippedReason})` : ""}`) } };
  } finally {
    await deps.exec("railway", ["unlink", "-y"], { cwd: dir }).catch(() => "");
    await rm(dir, { recursive: true, force: true });
  }
}

export async function measureEmails(deps: EmailDeps, previous: EmailState | undefined): Promise<{ output: PrecheckOutput; state?: EmailState }> {
  const at = deps.now();
  const sources: Sources = { errors: [] };
  const fail = (what: string) => (error: unknown) => { sources.errors.push(`${what}: ${message(error)}`); return undefined; };
  const railway = await readRailway(deps).catch(fail("Railway (Resend key and deploys)"));
  if (railway) sources.deploys = railway.deploys;
  const key = deps.resendKey || railway?.key;
  if (!key) { if (railway) sources.errors.push("Railway has no RESEND_API_KEY for slack-green-backend production"); }
  else sources.sends = await readSends(deps, key).catch(fail("Resend send log"));
  if (sources.sends) {
    const window = sources.sends.filter(send => send.at > at - DAY_MS || NUDGES.includes(send.template)).map(send => send.to);
    sources.recipients = await readRecipients(deps, window).catch(fail("Supabase recipients"));
  }
  sources.optedOut = await query<{ user_id: string }>(deps, "select user_id from email_preferences where marketing_consent = false order by user_id")
    .then(rows => rows.map(row => row.user_id)).catch(fail("Supabase opt-outs"));
  const { metrics, flagged } = emailMetrics(sources, at, previous);
  return { output: { metrics, flagged }, ...(sources.optedOut ? { state: { at, optedOut: sources.optedOut } } : {}) };
}

/** Each command stops 10 s before the runner's PRECHECK_TARGET_MS, so a hung Railway call still ends as a source error with every metric written. */
const COMMAND_TIMEOUT_MS = PRECHECK_TARGET_MS - 10_000;
const exec: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, cwd: options?.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args[0] ?? ""}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-emails: OUTPUT_FILE is not set\n"); process.exit(2); }
  const env = await readFile(join(REPO, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({}));
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as EmailState, () => undefined) : undefined;
  const deps: EmailDeps = { exec, fetch, now: Date.now, env, ...(process.env.RESEND_API_KEY ? { resendKey: process.env.RESEND_API_KEY } : {}) };
  const result = await measureEmails(deps, Array.isArray(previous?.optedOut) ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && result.state) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

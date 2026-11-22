import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The state of the automatic Claude grant renewal (scripts/claude-grant-renew.ts, run every 3 h by the Komodo Procedure m02-claude-grant-renew on us-metal02).
 * A Claude refresh grant has a fixed end about 28 days after its sign-in, and no refresh moves it: claude18@slack.green signed in at 04:36Z on
 * 11-15 and its grant ends at 08:12Z on 12-13. Each of about 20 paid pool accounts reaches that end on its own day, so from 11-13 to 11-16
 * skills_or_tools_to_fix missed 4 runs in a row while d5 jobs signed one account in by hand per run. The renewal signs each account in again
 * through the owner's Aside RENEW_LEAD_MS before its end, and pool_claude flags a grant end only when this state says the renewal failed or
 * could not run.
 */
export const RENEW_EVERY_MS = 3 * 3_600_000;
/** The renewal signs an account in again once its grant ends within this lead: 48 h before pool_claude's GRANT_WARN_MS, so 16 timer runs can
 * retry through a Mac outage like the 7 h one on 10-24 before any grant reaches the warning. */
export const RENEW_LEAD_MS = 4 * 86_400_000;
/** A state older than two missed timer runs plus an hour reads as a renewal that is not running. */
export const RENEW_STALE_MS = 2 * RENEW_EVERY_MS + 3_600_000;
/** The key of the box claude CLI's own login in `results`. */
export const CLI_KEY = "claude-cli";

export type RenewOutcome = "renewed" | "failed" | "prompt" | "mac-offline";
export interface RenewResult {
  /** When the attempt ended, ISO. */
  at: string;
  outcome: RenewOutcome;
  /** The account the attempt signed in, also for the CLI. */
  email: string;
  /** The grant end after a renewal, ms. */
  grantEnd?: number;
  detail: string;
}
export interface RenewalState {
  /** When the last run ended, ISO, whether or not any grant was due. */
  ranAt: string;
  /** Each account's latest attempt, keyed by lowercased email, and the CLI's under CLI_KEY. */
  results: Record<string, RenewResult>;
  /** The account a run found holding claude.ai in the owner's Aside and could not sign back in, which the next run restores. */
  restoreTo?: string;
}

export const renewalStateFile = (home: string = homedir()): string => join(home, ".local/state/claude-grant-renew/state.json");

export function parseRenewal(text: string | undefined): RenewalState | undefined {
  try {
    const state = JSON.parse(text ?? "") as Partial<RenewalState>;
    if (typeof state.ranAt !== "string" || !Number.isFinite(Date.parse(state.ranAt)) || typeof state.results !== "object" || state.results === null) return undefined;
    return { ranAt: state.ranAt, results: state.results, ...(typeof state.restoreTo === "string" ? { restoreTo: state.restoreTo } : {}) };
  } catch { return undefined; }
}

const minute = (ms: number) => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;

/**
 * Why a d5 job has to take this grant end, or undefined while the renewal covers it. A grant beyond RENEW_LEAD_MS is not due. A due grant is
 * flagged as soon as the renewal's latest attempt at it failed or reached a prompt, and at `warnMs` (pool_claude's GRANT_WARN_MS) when the
 * renewal has no state here, has stopped running, could not reach the owner's Aside, or has not renewed it yet.
 */
export function renewalGap(state: RenewalState | undefined, key: string, end: number, now: number, warnMs: number): string | undefined {
  if (end - now > RENEW_LEAD_MS) return undefined;
  const near = end - now <= warnMs;
  if (!state) return near ? "the grant renewal (Komodo Procedure m02-claude-grant-renew) has no state on this box" : undefined;
  const ran = Date.parse(state.ranAt);
  if (now - ran > RENEW_STALE_MS) return near ? `the grant renewal has not run since ${minute(ran)}` : undefined;
  const last = state.results[key.toLowerCase()];
  const fresh = last && now - Date.parse(last.at) <= RENEW_STALE_MS;
  if (fresh && (last.outcome === "failed" || last.outcome === "prompt")) return `the grant renewal ${last.outcome === "prompt" ? "reached a prompt" : "failed"} at ${minute(Date.parse(last.at))}: ${last.detail}`;
  if (!near) return undefined;
  if (fresh && last.outcome === "mac-offline") return `the grant renewal could not reach the owner's Aside at ${minute(Date.parse(last.at))}: ${last.detail}`;
  return `the grant renewal has not renewed it (last run ${minute(ran)})`;
}

/** pi-pool's refusal of an account whose organization does not allow OAuth: an unpaid plan, or a team member with no seat, as virev1, 3 and 7 read on 10-29 after Virev's admin moved its 12 seats to new members. No sign-in fixes it. */
export const NO_SEAT = "oauth not allowed for organization";

export interface PoolRow { id?: string; email?: string; tier?: string; reason?: string | null; cooldown_reason?: string | null; disabled?: boolean }
export interface DueAccount { id: string; email: string; end?: number; why: string }

/**
 * The pool accounts the renewal signs in this run, soonest grant end first: each live account that needs a sign-in or whose grant ends within
 * RENEW_LEAD_MS. It skips what pool_claude leaves to the owner: an account that is off, one whose organization refuses OAuth, a revoked team
 * member whose team already refuses a member for having no seat, and one whose last sign-in reached a recorded password, 2FA, passkey or
 * payment prompt (`prompted`, lowercased emails).
 */
export function dueAccounts(rows: readonly PoolRow[], ends: ReadonlyMap<string, number>, orgs: ReadonlyMap<string, string>, prompted: ReadonlySet<string>, now: number): DueAccount[] {
  const live = rows.filter(row => row.disabled !== true && row.id && row.email);
  const seatless = new Set(live.filter(row => row.tier?.startsWith("team") && row.cooldown_reason === NO_SEAT).flatMap(row => orgs.get(row.id!) ?? []));
  return live.flatMap(row => {
    if (row.cooldown_reason === NO_SEAT || prompted.has(row.email!.toLowerCase())) return [];
    if (row.reason === "needs-reauth" && row.tier?.startsWith("team") && seatless.has(orgs.get(row.id!) ?? "")) return [];
    const end = ends.get(row.id!);
    if (row.reason === "needs-reauth") return [{ id: row.id!, email: row.email!, ...(end === undefined ? {} : { end }), why: "needs a sign-in" }];
    return end !== undefined && end - now <= RENEW_LEAD_MS ? [{ id: row.id!, email: row.email!, end, why: `grant ends ${minute(end)}` }] : [];
  }).sort((a, b) => (a.end ?? 0) - (b.end ?? 0));
}

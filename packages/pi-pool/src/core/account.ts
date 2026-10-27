import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSelection, selectionName, type PoolCall, type Selection } from "./errors.ts";

export const POOLED_PROVIDERS = new Set(["anthropic", "openai-codex"]);
const FOLLOW = "follow";
const STATUS_KEY = "pi-pool";
export const STATUS_REFRESH_MS = 60_000;

/** One row of `pi-pool-token --cli ls --json`. The CLI owns every judgement in it. */
interface AccountRow {
  id: string; email: string; label: string; usage: string; session_pct: number; weekly_pct: number; gated_pct: number;
  disabled: boolean; usable: boolean; reason: string | null; current: boolean; pinned: boolean; live: boolean;
  score: number | null;
  plan?: string;
}
interface CliListing { provider: string; session: string | null; selection: Selection; rows: AccountRow[] }

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function rowLabel(row: AccountRow, provider: string): string {
  const tags = [row.current && "current", row.pinned && "selected", row.disabled && "Off", row.usable ? "Auto eligible" : "Auto ineligible", row.reason, row.live && "supervised"]
    .filter((tag): tag is string => Boolean(tag));
  const usage = [`5h ${pct(row.session_pct)}`, `week ${pct(row.weekly_pct)}`];
  if (provider === "anthropic") usage.push(`fable ${pct(row.gated_pct)}`);
  return `Manual ${row.label}${row.plan ? ` ${row.plan}` : ""}  ${usage.join(" · ")}${tags.length ? `  ${tags.join(", ")}` : ""}`;
}

/** Accounts that take this session first, best score first, then the rest; the picker reads top down. */
function pickerRows(rows: AccountRow[]): AccountRow[] {
  return [...rows].sort((a, b) => Number(b.usable) - Number(a.usable) || (b.score ?? -1) - (a.score ?? -1) || a.label.localeCompare(b.label));
}

type Listed = { ok: true; data: CliListing } | { ok: false; out: string };

export async function listAccounts(pool: PoolCall, provider: string, sid: string | undefined): Promise<Listed> {
  const args = ["ls", "--json", "--provider", provider];
  if (sid) args.push("--session", sid);
  const res = await pool(args);
  let reply: unknown;
  try {
    reply = JSON.parse(res.out);
  } catch {
    return { ok: false, out: res.ok ? `unreadable JSON from the pool: ${res.out.slice(0, 200)}` : res.out };
  }
  const listing = reply as Partial<CliListing> & { error?: string };
  if (!Array.isArray(listing.rows) || !isSelection(listing.selection)) return { ok: false, out: listing.error ?? "invalid account listing" };
  return { ok: true, data: listing as CliListing };
}

/** One provider of `pi-pool-token --cli who --json`. */
interface WhoProvider {
  selection: Selection;
  error?: string;
  wait?: { account: string; slot_at: number } | null;
  current: { id: string; email: string; label: string; session_pct: number; weekly_pct: number; gated_pct: number; next: string | false } | null;
}
export type WhoReply = { providers?: Record<string, WhoProvider> };

interface WhoRun { startedAt: number; done: boolean; reply: Promise<WhoReply | undefined> }
const WHO_RUN: unique symbol = Symbol.for("sieun-pi.pi-stack.pool.who-run");
const shared = globalThis as typeof globalThis & { [WHO_RUN]?: WhoRun };

/**
 * The pool's `who` answer, one run shared by every session in the process. `who` reads the pool's selection and the
 * current account, which the session key does not change, so one run serves every session.
 */
export function who(pool: PoolCall, fresh: boolean): Promise<WhoReply | undefined> {
  const last = shared[WHO_RUN];
  if (last && !fresh && (!last.done || Date.now() - last.startedAt < STATUS_REFRESH_MS)) return last.reply;
  const run: WhoRun = {
    startedAt: Date.now(),
    done: false,
    reply: pool(["who", "--json"])
      .then(res => {
        const reply = JSON.parse(res.out) as WhoReply;
        if (Object.values(reply.providers ?? {}).some(info => !isSelection(info.selection))) return undefined;
        return reply;
      })
      .catch(() => undefined)
      .finally(() => {
        run.done = true;
      }),
  };
  shared[WHO_RUN] = run;
  return run.reply;
}

/** The account line in the footer: the account this session's requests use and its usage. */
export async function refreshStatus(ctx: ExtensionContext, pool: PoolCall, fresh = false): Promise<void> {
  try {
    const provider = ctx.model?.provider;
    if (!provider || !POOLED_PROVIDERS.has(provider)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const reply = await who(pool, fresh);
    if (!reply) return;
    const info = reply.providers?.[provider];
    const theme = ctx.ui.theme;
    if (!info) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "pool unavailable"));
      return;
    }
    const mode = info.selection.mode === "auto" ? "Auto" : "Manual";
    if (info.error || !info.current || (info.selection.mode === "manual" && info.current.id !== info.selection.account_id)) {
      const state = info.error || "no pooled account";
      const label = info.selection.mode === "manual" && info.current?.id === info.selection.account_id ? info.current.label : undefined;
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `account ${selectionName(info.selection, label)} · ${state}`));
      return;
    }
    const cur = info.current;
    const usage = [`5h ${pct(cur.session_pct)}`, `week ${pct(cur.weekly_pct)}`];
    if (provider === "anthropic") usage.push(`fable ${pct(cur.gated_pct)}`);
    const hot = Math.max(cur.session_pct, cur.weekly_pct, cur.gated_pct);
    const color = hot >= 95 ? "error" : hot >= 75 ? "warning" : "dim";
    const next = info.selection.mode === "auto" && cur.next ? theme.fg("accent", ` → ${cur.next}`) : "";
    ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", `account ${mode} ${cur.label}`)} ${theme.fg(color, usage.join(" · "))}${next}`);
  } catch {
    // A status line must never break the session; the last text stays.
  }
}

/** The /account command: Auto or one Manual account for this session's tree. */
export function accountCommand(pool: (ctx: ExtensionContext) => PoolCall, sessionOf: (ctx: ExtensionContext) => string | undefined, anyPool: PoolCall) {
  return {
    description: "Choose Auto pool selection or a Manual account for this session",
    getArgumentCompletions: async () => {
      try {
        const listings = await Promise.all([...POOLED_PROVIDERS].map(provider => listAccounts(anyPool, provider, undefined)));
        const labels = listings.flatMap(listed => (listed.ok ? listed.data.rows.map(row => row.label) : []));
        return [...new Set(labels), FOLLOW].map(value => ({ value, label: value === FOLLOW ? "Auto" : `Manual ${value}` }));
      } catch {
        return [{ value: FOLLOW, label: "Auto" }];
      }
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const provider = ctx.model?.provider;
        if (!provider || !POOLED_PROVIDERS.has(provider)) {
          ctx.ui.notify(`pi-pool has no pool for ${provider ?? "this model"}`, "warning");
          return;
        }
        const call = pool(ctx);
        const sid = sessionOf(ctx);
        const listed = await listAccounts(call, provider, sid);
        if (!listed.ok) {
          ctx.ui.notify(`pi-pool: ${listed.out}`, "error");
          return;
        }
        const data = listed.data;
        const followLabel = "Auto (let the pool choose and switch accounts)";
        let target = args.trim();
        if (!target) {
          const rows = pickerRows(data.rows);
          const selection = data.selection;
          const selected = selection.mode === "manual" ? rows.find(row => row.id === selection.account_id) : rows.find(row => row.current);
          const choice = await ctx.ui.select(`Account for this session (${provider}) · ${selectionName(selection, selected?.label)}`, [followLabel, ...rows.map(row => rowLabel(row, provider))]);
          if (choice === undefined) return;
          target = choice === followLabel ? FOLLOW : (rows.find(row => rowLabel(row, provider) === choice)?.id ?? choice);
        }
        const useArgs = [...(target === FOLLOW ? ["use", "--follow"] : ["use", target]), "--provider", provider];
        if (sid) useArgs.push("--session", sid);
        const res = await call(useArgs);
        ctx.ui.notify(res.out || (res.ok ? "done" : "pi-pool use failed"), res.ok ? "info" : "error");
        await refreshStatus(ctx, call, true);
      } catch (err) {
        ctx.ui.notify(`pi-pool /account failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  };
}

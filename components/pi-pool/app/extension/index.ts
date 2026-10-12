/**
 * pi-pool inside Prime Agent: the /account picker, the footer status that
 * names the account this session's requests use, and adoption of a stored
 * /login that would otherwise bypass the pool.
 *
 * A provider 429 on a pooled provider is reported to the pool (`limited`); when
 * another account takes the session, the failed message loses its reset time, so
 * Prime retries in about a second and the hook vends that account in the same
 * turn. When none does, the pool gives the session its own slot time and the
 * message waits until then, not until the provider's reset.
 * A 400 or 403 goes to the pool too (`refused`): when its text names an
 * account-level refusal, such as Consumer Terms not yet accepted, the pool takes
 * the account out and the same turn retries on another one the same way.
 *
 * A turn that failed because the token hook gave no token, such as a hook the
 * Mac slept through, loses Prime's lifecycle-failure tag so Prime retries it. When
 * the hook gave no token because the session waits for a slot, the failure
 * becomes a rate limit that waits until that slot.
 *
 * Every judgement lives in `pi-pool-token --cli`. This file parses JSON and
 * formats strings, so the precedence rules and the usage math exist once, in
 * Python. Everything here goes through the public extension API, so it keeps
 * working across Prime Agent updates with nothing to re-apply.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The root installer links this directory into <agent dir>/extensions, so the
// loader's own path points at the link, not at the pool.
const HERE = realpathSync(dirname(fileURLToPath(import.meta.url)));
const POOL_BIN = join(dirname(dirname(HERE)), "bin", "pi-pool-token");
const SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const POOLED_PROVIDERS = new Set(["anthropic", "openai-codex"]);
const FOLLOW = "follow";
const WIDGET_KEY = "pi-pool";
const STATUS_REFRESH_MS = 60_000;

/** One row of `pi-pool-token --cli ls --json`. The CLI owns every judgement in it. */
interface AccountRow {
	id: string; email: string; label: string; usage: string; session_pct: number; weekly_pct: number; gated_pct: number;
	usable: boolean; reason: string | null; current: boolean; pinned: boolean; live: boolean;
	/** How much the pool prefers this account for this session; null when it cannot take the session. */
	score: number | null;
	/** openai-codex only: free | plus | pro | team. The pool sends no plan for anthropic. */
	plan?: string;
}
interface CliListing {
	provider: string; session: string | null; rows: AccountRow[];
}
/** Every CLI verb answers with a listing or with `{"error": "..."}`. */
type CliReply = CliListing | { error: string };

function isListing(reply: CliReply): reply is CliListing {
	return Array.isArray((reply as CliListing).rows);
}

/** Runs the pool CLI. Never throws; a failed run becomes a notify. */
function pool(args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(POOL_BIN, ["--cli", ...args], { timeout: 10_000 }, (error, stdout, stderr) => {
			// The CLI reports its own refusals on stdout and exits non-zero, so stdout
			// carries the message even when execFile calls the run a failure.
			const out = (stdout || "").trim() || (stderr || "").trim();
			if (error) resolve({ ok: false, out: out || error.message || "pi-pool-token failed" });
			else resolve({ ok: true, out });
		});
	});
}

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return id;
	} catch {
		// Fall through to the env var below.
	}
	const fromEnv = process.env[SESSION_ENV];
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
}

function rowLabel(row: AccountRow, provider: string): string {
	const tags = [row.current && "current", row.pinned && "pinned", row.reason, row.live && "supervised"]
		.filter((tag): tag is string => Boolean(tag));
	const usage = [`5h ${pct(row.session_pct)}`, `week ${pct(row.weekly_pct)}`];
	if (provider === "anthropic") usage.push(`fable ${pct(row.gated_pct)}`);
	return `${row.label}${row.plan ? ` ${row.plan}` : ""}  ${usage.join(" · ")}${tags.length ? `  ${tags.join(", ")}` : ""}`;
}

/** Accounts that take this session first, best score first, then the rest; the picker reads top down. */
function pickerRows(rows: AccountRow[]): AccountRow[] {
	return [...rows].sort((a, b) => Number(b.usable) - Number(a.usable) || (b.score ?? -1) - (a.score ?? -1) || a.label.localeCompare(b.label));
}

type Listed = { ok: true; out: string; data: CliListing } | { ok: false; out: string };

async function listAccounts(provider: string, sid: string | undefined): Promise<Listed> {
	const args = ["ls", "--json", "--provider", provider];
	if (sid) args.push("--session", sid);
	const res = await pool(args);
	let reply: CliReply;
	try {
		reply = JSON.parse(res.out) as CliReply;
	} catch {
		return { ok: false, out: res.ok ? `unreadable JSON from ${POOL_BIN}: ${res.out.slice(0, 200)}` : res.out };
	}
	if (!isListing(reply)) return { ok: false, out: reply.error };
	return { ok: true, out: res.out, data: reply };
}

async function applyChoice(ctx: ExtensionCommandContext, provider: string, sid: string | undefined, target: string): Promise<void> {
	const args = [...(target === FOLLOW ? ["use", "--follow"] : ["use", target]), "--provider", provider];
	if (sid) args.push("--session", sid);
	const res = await pool(args);
	ctx.ui.notify(res.out || (res.ok ? "done" : "pi-pool use failed"), res.ok ? "info" : "error");
	await refreshStatus(ctx, true);
}

/** One provider of `pi-pool-token --cli who --json`. */
interface WhoProvider {
	error?: string;
	/** The session's slot while it waits for an account; null when it does not wait. */
	wait?: { account: string; slot_at: number } | null;
	current: { email: string; label: string; session_pct: number; weekly_pct: number; gated_pct: number; next: string | false } | null;
}
type WhoReply = { providers?: Record<string, WhoProvider> };

/** One `who` run, shared by every session in this process. */
interface WhoRun { startedAt: number; done: boolean; reply: Promise<WhoReply | undefined> }

// On globalThis, so every load of this extension in one process shares the run.
const WHO_RUN: unique symbol = Symbol.for("pi-pool.who-run");
const shared = globalThis as typeof globalThis & { [WHO_RUN]?: WhoRun };

/**
 * The pool's `who` answer. A caller joins the run in flight, or reuses one that
 * started under STATUS_REFRESH_MS ago; `fresh` starts a new run, for a change
 * this session just made.
 */
function who(fresh: boolean): Promise<WhoReply | undefined> {
	const last = shared[WHO_RUN];
	if (last && !fresh && (!last.done || Date.now() - last.startedAt < STATUS_REFRESH_MS)) return last.reply;
	const run: WhoRun = {
		startedAt: Date.now(),
		done: false,
		reply: pool(["who", "--json"])
			.then((res) => JSON.parse(res.out) as WhoReply)
			.catch(() => undefined)
			.finally(() => {
				run.done = true;
			}),
	};
	shared[WHO_RUN] = run;
	return run.reply;
}

/** A person can see this session's widget: a UI is bound and the session is no RLM child. */
function showsStatus(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	const header = ctx.sessionManager?.getHeader?.();
	return (header?.rlmDepth ?? (header?.parentSession ? 1 : 0)) === 0;
}

function pct(n: number): string {
	return `${Math.round(n)}%`;
}

/** One line by the editor. Prime 0.9.5 stores setStatus text but its footer never draws it, so a widget carries the line. */
function showLine(ctx: ExtensionContext, text: string): void {
	ctx.ui.setWidget(WIDGET_KEY, [text], { placement: "belowEditor" });
}

/** The account this session's requests use, and that account's usage. Sessions nobody sees skip it. */
async function refreshStatus(ctx: ExtensionContext, fresh = false): Promise<void> {
	try {
		if (!showsStatus(ctx)) return;
		const provider = ctx.model?.provider;
		if (!provider || !POOLED_PROVIDERS.has(provider)) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const reply = await who(fresh);
		// A failed run leaves the last text in place.
		if (!reply) return;
		const info = reply.providers?.[provider];
		const theme = ctx.ui.theme;
		if (!info || info.error || !info.current) {
			showLine(ctx, theme.fg("warning", info?.error ? "pool unavailable" : "no pooled account"));
			return;
		}
		const cur = info.current;
		const usage = [`5h ${pct(cur.session_pct)}`, `week ${pct(cur.weekly_pct)}`];
		if (provider === "anthropic") usage.push(`fable ${pct(cur.gated_pct)}`);
		const hot = Math.max(cur.session_pct, cur.weekly_pct, cur.gated_pct);
		const color = hot >= 95 ? "error" : hot >= 75 ? "warning" : "dim";
		const next = cur.next ? theme.fg("accent", ` → ${cur.next}`) : "";
		showLine(ctx, `${theme.fg("dim", `account ${cur.label}`)} ${theme.fg(color, usage.join(" · "))}${next}`);
	} catch {
		// A status line must never break the session. Leave the last text in place.
	}
}

/** Tells the pool which model this session runs, so a spent Fable cap only stops an account for sessions on Fable. */
async function recordModel(ctx: ExtensionContext, model = ctx.model): Promise<void> {
	const sid = sessionId(ctx);
	if (!sid) return;
	await pool(model && POOLED_PROVIDERS.has(model.provider) ? ["model", model.id, "--provider", model.provider, "--source", sid] : ["model", "--clear", "--source", sid]);
}

/** Prime's parseProviderResetMs pattern. A reset phrase left in the text would bring the long wait back. */
const RESET_PHRASE = /(?:try again|resets?|available)[^.]{0,80}?(?:~\s*)?\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b\.?/gi;

/** `pi-pool-token --cli limited` answer. `next` names the account the retry enters now; when it is null, `retry_at` (epoch sec) is the session's own slot. */
interface LimitedReply { account: string | null; until: number; next: string | null; retry_at?: number | null; stale?: boolean }
/** `pi-pool-token --cli refused` answer. `reason` is null when the text names no account-level refusal. */
interface RefusedReply { account?: string; reason: string | null; next?: string | null; retry_at?: number | null }

async function poolJson<T>(args: string[]): Promise<T | undefined> {
	const res = await pool(args);
	if (!res.ok) return undefined;
	try {
		return JSON.parse(res.out) as T;
	} catch {
		return undefined;
	}
}

/**
 * Longest single wait the extension asks Prime for. A session whose slot is further
 * away wakes at this interval, and the pool hands it its slot again, so a session
 * also picks up an account that frees early or a new login.
 */
const WAIT_RECHECK_MS = 15 * 60_000;

/** The retryAfterMs that makes Prime's usage wait sleep until `slotAt` (epoch sec). */
function waitMs(slotAt: number): number {
	return Math.min(WAIT_RECHECK_MS, Math.max(1000, slotAt * 1000 - Date.now()));
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** A rate-limit failure Prime's wait-for-usage sleeps on for `ms`, with the "Try again in" text to match. */
function waitFailure(message: AssistantMessage, original: string, said: string, details: Record<string, unknown>, ms: number, failure: unknown): AgentMessage {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	const diagnostic = { type: "provider_stream_failure", timestamp: Date.now(), details: { ...details, status: 429, kind: "rate_limit", retryAfterMs: ms } };
	const others = (message.diagnostics ?? []).filter((d) => d !== failure && d.type !== "agent_lifecycle_failure");
	return {
		...message,
		errorMessage: `${original} ${said} Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`.trim(),
		diagnostics: [...others, diagnostic] as AssistantMessage["diagnostics"],
	};
}

/**
 * A failed request on a pooled provider.
 *
 * A 429: tell the pool the account is limited until the provider's reset. When
 * another account takes the session, return the message without the reset, so
 * Prime's usage wait pings after about 1s and that ping's hook call vends the
 * other account. When none does, the pool gives the session its own slot
 * (`retry_at`), and the message waits until then, at most WAIT_RECHECK_MS at a
 * time. On 2026-10-12 15:04 a session waited 1 h 45 min for its own account's
 * reset while another account came back at 15:30.
 *
 * A 400 or 403: the pool reads the error text. An account-level refusal (terms
 * not accepted, OAuth off for the organization) takes the account out of the
 * pool; the message is then re-labelled a rate limit, the one failure kind Prime
 * retries for an account, so the same turn moves on the same way. Prime treats
 * any other 400 as permanent, and the pool leaves it alone.
 */
async function swapAccount(message: AgentMessage): Promise<AgentMessage | undefined> {
	if (message.role !== "assistant" || message.stopReason !== "error" || !POOLED_PROVIDERS.has(message.provider)) return undefined;
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
	const details = (failure?.details ?? {}) as Record<string, unknown>;
	const original = (message.errorMessage ?? "").replace(RESET_PHRASE, "").trim();
	const withDetails = (next: Record<string, unknown>) => message.diagnostics?.map((diagnostic) => (diagnostic === failure ? { ...diagnostic, details: next } : diagnostic));
	if (details.status === 429) {
		// A 429 with no reset time still marks the account, for a short while.
		const resetMs = typeof details.retryAfterMs === "number" ? details.retryAfterMs : 5 * 60_000;
		const until = (Date.now() + resetMs) / 1000;
		// The request was sent at the message's timestamp: a 429 from before this tree moved accounts marks nothing.
		const reply = await poolJson<LimitedReply>(["limited", "--provider", message.provider, "--until", String(until), "--since", String(message.timestamp / 1000)]);
		if (!reply) return undefined;
		if (!reply.next) {
			if (typeof reply.retry_at !== "number") return undefined;
			const said = `pi-pool: ${reply.account} is limited until ${new Date(reply.until * 1000).toISOString()}; this session waits for its slot at ${new Date(reply.retry_at * 1000).toISOString()}.`;
			return waitFailure(message, original, said, details, waitMs(reply.retry_at), failure);
		}
		const { retryAfterMs: _reset, ...rest } = details;
		const said = reply.stale ? `pi-pool: this 429 came from the account the session already left` : `pi-pool: ${reply.account} is limited until ${new Date(reply.until * 1000).toISOString()}`;
		return {
			...message,
			errorMessage: `${original} ${said}; the retry uses ${reply.next}.`.trim(),
			diagnostics: withDetails(rest),
		};
	}
	if (details.status === 400 || details.status === 403) {
		const reply = await poolJson<RefusedReply>(["refused", "--provider", message.provider, message.errorMessage ?? ""]);
		if (!reply?.reason) return undefined;
		if (!reply.next) {
			if (typeof reply.retry_at !== "number") return undefined;
			const said = `pi-pool: ${reply.account} is out of the pool (${reply.reason}); this session waits for its slot at ${new Date(reply.retry_at * 1000).toISOString()}.`;
			return waitFailure(message, original, said, details, waitMs(reply.retry_at), failure);
		}
		return {
			...message,
			errorMessage: `${original} pi-pool: ${reply.account} is out of the pool (${reply.reason}); the retry uses ${reply.next}.`.trim(),
			diagnostics: withDetails({ ...details, kind: "rate_limit" }),
		};
	}
	return undefined;
}

/** Prime's error when the apiKey command fails, times out at 10 s, or prints nothing. */
const HOOK_FAILED = /^Failed to resolve API key for provider "[^"]+" from shell command: .*pi-pool-token/;

/**
 * A pool hook run that gave no token. When the session waits for a slot (the pool
 * gives no token to a waiting session whose own account still serves), the
 * failure becomes a rate limit that waits until the slot. Otherwise: Prime runs
 * the hook with a 10 s timeout; on 2026-10-08 every such failure fell where the
 * Mac, lid closed on battery, went back to sleep during a dark wake. Prime tags
 * the throw an agent lifecycle failure, the one kind it never retries. It is a
 * failed credential lookup, so the tag comes off and Prime's own retry runs the
 * hook again, up to retry.maxRetries times.
 */
async function retryHookFailure(message: AgentMessage): Promise<AgentMessage | undefined> {
	if (message.role !== "assistant" || message.stopReason !== "error" || !POOLED_PROVIDERS.has(message.provider)) return undefined;
	if (!HOOK_FAILED.test(message.errorMessage ?? "")) return undefined;
	if (!message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure")) return undefined;
	const wait = (await who(true))?.providers?.[message.provider]?.wait;
	if (wait && typeof wait.slot_at === "number") {
		const said = `pi-pool: this session waits for its slot at ${new Date(wait.slot_at * 1000).toISOString()}.`;
		return waitFailure(message, message.errorMessage ?? "", said, {}, waitMs(wait.slot_at), undefined);
	}
	return {
		...message,
		errorMessage: `${message.errorMessage} pi-pool: the token hook gave no token; the retry uses a new hook run.`,
		diagnostics: message.diagnostics.filter((diagnostic) => diagnostic.type !== "agent_lifecycle_failure"),
	};
}

/** Moves a stored /login for a pooled provider into the pool's fallback, so it cannot shadow the pool. */
async function adoptLogins(ctx: ExtensionContext): Promise<void> {
	const res = await pool(["adopt-logins"]);
	if (res.ok && res.out) ctx.ui.notify(`pi-pool: ${res.out}`, "info");
	else if (!res.ok) ctx.ui.notify(`pi-pool: ${res.out}`, "warning");
}

export default function (pi: ExtensionAPI): void {
	// One set of timers per loaded extension instance. Plain timers rather than
	// ctx.setInterval, which the locked 0.9.4 types lack; session_shutdown clears
	// them so a replaced session's ctx is never used again.
	let timers: ReturnType<typeof setTimeout>[] = [];
	const clearTimers = (): void => {
		for (const timer of timers) clearTimeout(timer);
		timers = [];
	};
	pi.on("session_start", async (_event, ctx) => {
		clearTimers();
		await adoptLogins(ctx);
		await recordModel(ctx);
		// Refusal check across the pool; the CLI rate-limits itself to once per 6h.
		void pool(["probe"]);
		if (!showsStatus(ctx)) return;
		await refreshStatus(ctx);
		// A widget set while the TUI client is still attaching can be dropped; set it again once attached.
		timers.push(setTimeout(() => void refreshStatus(ctx), 3000));
		timers.push(setInterval(() => void refreshStatus(ctx), STATUS_REFRESH_MS));
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		const sid = sessionId(ctx);
		if (sid) await pool(["model", "--clear", "--source", sid]);
	});
	pi.on("model_select", async (event, ctx) => {
		await recordModel(ctx, event.model);
		await refreshStatus(ctx, true);
	});
	pi.on("turn_end", async (_event, ctx) => refreshStatus(ctx));
	pi.on("message_end", async (event) => {
		const message = (await retryHookFailure(event.message)) ?? (await swapAccount(event.message));
		return message ? { message } : undefined;
	});

	pi.registerCommand("account", {
		description: "Switch the pooled account for this session",
		getArgumentCompletions: async (): Promise<AutocompleteItem[]> => {
			// No ctx here, so the model's provider is unknown. Offer both pools.
			try {
				const listings = await Promise.all([...POOLED_PROVIDERS].map((provider) => listAccounts(provider, undefined)));
				const labels = listings.flatMap((listed) => (listed.ok ? listed.data.rows.map((row) => row.label) : []));
				return [...new Set(labels), FOLLOW].map((value) => ({ value, label: value }));
			} catch {
				return [{ value: FOLLOW, label: FOLLOW }];
			}
		},
		handler: async (args, ctx) => {
			try {
				const provider = ctx.model?.provider;
				if (!provider || !POOLED_PROVIDERS.has(provider)) {
					ctx.ui.notify(`pi-pool has no pool for ${provider ?? "this model"}`, "warning");
					return;
				}
				const sid = sessionId(ctx);
				const listed = await listAccounts(provider, sid);
				if (!listed.ok) {
					ctx.ui.notify(`pi-pool: ${listed.out}`, "error");
					return;
				}
				const data = listed.data;
				const followLabel = "Follow the pool (stay on the current account until it runs out)";
				const trimmed = args.trim();
				let target: string;
				if (trimmed) {
					target = trimmed === FOLLOW ? FOLLOW : trimmed;
				} else {
					const rows = pickerRows(data.rows);
					const choice = await ctx.ui.select(`Account for this session (${provider})`, [followLabel, ...rows.map((row) => rowLabel(row, provider))]);
					if (choice === undefined) return;
					target = choice === followLabel ? FOLLOW : (rows.find((row) => rowLabel(row, provider) === choice)?.id ?? choice);
				}
				if (target !== FOLLOW) {
					const row = data.rows.find((candidate) => [candidate.id, candidate.label, candidate.email].includes(target));
					if (row && !row.usable) {
						const ok = await ctx.ui.confirm("Account cannot take this session", `${row.label} is ${row.reason ?? "unusable"} right now, so the pin waits: the session moves there only when it must move or starts cold. Pin it?`);
						if (!ok) return;
					}
				}
				await applyChoice(ctx, provider, sid, target);
			} catch (err) {
				ctx.ui.notify(`pi-pool /account failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The root installer links this directory into <agent dir>/extensions, so the
// loader's own path points at the link, not at the pool.
const HERE = realpathSync(dirname(fileURLToPath(import.meta.url)));
const POOL_BIN = poolBin(HERE);

/**
 * The pool CLI that the extension in `here` calls. An installed release calls the CLI
 * of `current`, not its own: a session keeps the extension it loaded until it reloads,
 * and on 10-14 sessions still on release 6601cc2bbdfd ran its owner-turn code after
 * 00a7feba9b52 went live at 11:32:34 KST, logging owner admits that waited 175.8 s
 * (12:06:26) and 32.3 s (12:22:13). So the CLI keeps accepting every argument an older
 * extension sends. A checkout, install.py's `.staging-` folder or any other folder calls its own CLI,
 * so the install tests run the staged CLI and not the live one.
 */
export function poolBin(here: string): string {
	const root = dirname(dirname(here));
	const releases = dirname(root);
	const staged = basename(root).startsWith(".staging-");
	const base = basename(releases) === "releases" && !staged ? join(dirname(releases), "current") : root;
	return join(base, "bin", "pi-pool-token");
}
const SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const POOLED_PROVIDERS = new Set(["anthropic", "openai-codex"]);
const FOLLOW = "follow";
const WIDGET_KEY = "pi-pool";
const STATUS_REFRESH_MS = 60_000;

type Selection = { mode: "auto" } | { mode: "manual"; account_id: string };

function isSelection(value: unknown): value is Selection {
	if (!value || typeof value !== "object" || !("mode" in value)) return false;
	return value.mode === "auto" || (value.mode === "manual" && "account_id" in value && typeof value.account_id === "string" && value.account_id.length > 0);
}

function selectionName(selection: Selection, label?: string): string {
	return selection.mode === "auto" ? `Auto${label ? ` ${label}` : ""}` : `Manual ${label ?? selection.account_id}`;
}

/** One row of `pi-pool-token --cli ls --json`. The CLI owns every judgement in it. */
interface AccountRow {
	id: string; email: string; label: string; usage: string; session_pct: number; weekly_pct: number; gated_pct: number;
	disabled: boolean; usable: boolean; reason: string | null; current: boolean; pinned: boolean; live: boolean;
	/** How much the pool prefers this account for this session; null when it cannot take the session. */
	score: number | null;
	/** openai-codex only: free | plus | pro | team. The pool sends no plan for anthropic. */
	plan?: string;
}
interface CliListing {
	provider: string; session: string | null; selection: Selection; rows: AccountRow[];
}
/** Every CLI verb answers with a listing or with `{"error": "..."}`. */
type CliReply = CliListing | { error: string };

function isListing(reply: CliReply): reply is CliListing {
	return "rows" in reply && Array.isArray(reply.rows) && isSelection(reply.selection);
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
	if (!isListing(reply)) return { ok: false, out: "error" in reply ? reply.error : "invalid account listing" };
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
	selection: Selection;
	error?: string;
	/** The session's slot while it waits for an account; null when it does not wait. */
	wait?: { account: string; slot_at: number } | null;
	current: { id: string; email: string; label: string; session_pct: number; weekly_pct: number; gated_pct: number; next: string | false } | null;
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
			.then((res) => {
				const reply = JSON.parse(res.out) as WhoReply;
				if (Object.values(reply.providers ?? {}).some((info) => !isSelection(info.selection))) return undefined;
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
		if (!info) {
			showLine(ctx, theme.fg("warning", "pool unavailable"));
			return;
		}
		const mode = info.selection.mode === "auto" ? "Auto" : "Manual";
		if (info.error || !info.current || (info.selection.mode === "manual" && info.current.id !== info.selection.account_id)) {
			const state = info.error || "no pooled account";
			const label = info.selection.mode === "manual" && info.current?.id === info.selection.account_id ? info.current.label : undefined;
			showLine(ctx, theme.fg("warning", `account ${selectionName(info.selection, label)} · ${state}`));
			return;
		}
		const cur = info.current;
		const usage = [`5h ${pct(cur.session_pct)}`, `week ${pct(cur.weekly_pct)}`];
		if (provider === "anthropic") usage.push(`fable ${pct(cur.gated_pct)}`);
		const hot = Math.max(cur.session_pct, cur.weekly_pct, cur.gated_pct);
		const color = hot >= 95 ? "error" : hot >= 75 ? "warning" : "dim";
		const next = info.selection.mode === "auto" && cur.next ? theme.fg("accent", ` → ${cur.next}`) : "";
		showLine(ctx, `${theme.fg("dim", `account ${mode} ${cur.label}`)} ${theme.fg(color, usage.join(" · "))}${next}`);
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
interface LimitedReply { selection: Selection; account: string | null; until: number; next: string | null; retry_at?: number | null; stale?: boolean }
/** `pi-pool-token --cli refused` answer. `reason` is null when the text names no account-level refusal. */
interface RefusedReply { selection: Selection; account?: string; reason: string | null; next?: string | null; retry_at?: number | null }

/** The CLI's JSON answer, undefined when the answer is unreadable, or "failed" when the run itself failed. */
async function poolJson<T extends { selection: Selection }>(args: string[]): Promise<T | undefined | "failed"> {
	const res = await pool(args);
	if (!res.ok) return "failed";
	try {
		const reply = JSON.parse(res.out) as T;
		return isSelection(reply.selection) ? reply : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The retryAfterMs that makes Prime's usage wait sleep until `slotAt` (epoch sec), in one
 * sleep. The pool holds the tree's slot, at or after the reset of the account that frees first, so a wake before it
 * only meets the same answer: on 10-18 08:32Z a 15-min cap
 * put a second error line in a Mac session that waited 23 min for its slot.
 */
function waitMs(slotAt: number): number {
	return Math.max(1000, slotAt * 1000 - Date.now());
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function manualFailure(message: AssistantMessage, selection: Extract<Selection, { mode: "manual" }>): AssistantMessage {
	return { ...message, errorMessage: `${message.errorMessage ?? ""} pi-pool: ${selectionName(selection)} remains selected.`.trim() };
}

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
 * (`retry_at`), and the message waits until then. On 2026-10-12 15:04 a session waited 1 h 45 min for its own account's
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
		const { retryAfterMs: _reset, ...rest } = details;
		if (reply === "failed") {
			// The run fails only when the pool flock stays busy past STATE_LOCK_TIMEOUT and the limited spool cannot take the
			// report either (pool/limited.py). On 10-19 35 of 1,927 anthropic 429s on us-metal02 kept the reset when the flock
			// alone was busy and slept up to 4.2 h. An Auto session drops it, so Prime's backoff pings soon and that 429
			// reports again; `who` reads the selection without the lock.
			const selection = (await who(true))?.providers?.[message.provider]?.selection;
			if (selection?.mode === "manual") return manualFailure(message, selection);
			if (selection?.mode !== "auto") return undefined;
			return { ...message, errorMessage: `${original} pi-pool: the pool did not record this 429; the retry reports it again.`.trim(), diagnostics: withDetails(rest) };
		}
		if (!reply) return undefined;
		if (reply.selection.mode === "manual") return manualFailure(message, reply.selection);
		if (!reply.next) {
			if (typeof reply.retry_at !== "number") return undefined;
			const said = `pi-pool: ${reply.account} is limited until ${new Date(reply.until * 1000).toISOString()}; this session waits for its slot at ${new Date(reply.retry_at * 1000).toISOString()}.`;
			return waitFailure(message, original, said, details, waitMs(reply.retry_at), failure);
		}
		const said = reply.stale ? `pi-pool: this 429 came from the account the session already left` : `pi-pool: ${reply.account} is limited until ${new Date(reply.until * 1000).toISOString()}`;
		return {
			...message,
			errorMessage: `${original} ${said}; the retry uses ${reply.next}.`.trim(),
			diagnostics: withDetails(rest),
		};
	}
	if (details.status === 400 || details.status === 403) {
		const reply = await poolJson<RefusedReply>(["refused", "--provider", message.provider, message.errorMessage ?? ""]);
		if (!reply || reply === "failed") return undefined;
		if (reply.selection.mode === "manual") return manualFailure(message, reply.selection);
		if (!reply.reason) return undefined;
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
	const info = (await who(true))?.providers?.[message.provider];
	if (!info) return undefined;
	const wait = info.wait;
	if (info.selection.mode === "manual") {
		// A wait for this exact pin is transient; an old wait or an auth refusal is not.
		if (!info.error && wait?.account === info.selection.account_id && typeof wait.slot_at === "number") {
			const label = info.current?.id === info.selection.account_id ? info.current.label ?? info.current.email : undefined;
			const said = `pi-pool: ${selectionName(info.selection, label)} remains selected; this session waits for its slot at ${new Date(wait.slot_at * 1000).toISOString()}.`;
			return waitFailure(message, message.errorMessage ?? "", said, {}, waitMs(wait.slot_at), undefined);
		}
		const result = manualFailure(message, info.selection);
		return info.error ? { ...result, errorMessage: `${result.errorMessage} ${info.error}` } : result;
	}
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

/**
 * This machine's turn queue (pool/turns.py). A run takes a working slot at its first
 * model call: the `context` handler awaits its admit, which Prime awaits with no
 * timeout before every model call from every turn source, agent-message wakes and
 * retries included. The run keeps the slot until agent_end and renews its lease from
 * its model calls, at most once per QUEUE_RENEW_MS, so a run stuck in one tool call
 * loses its slot after lease_s with no model call and takes it back at once on its next
 * one. A timer gives the slot back when it finds the session idle, because agent_end
 * does not fire on some aborts. A failed admit lets the run go.
 *
 * The extension marks no owner turn. Every prompt the daemon delivers reads as source
 * "interactive", so on 10-14 the input hook marked 21 [job] notices, 6 [brief check]
 * notes and 51 duty and check-in briefs as owner turns
 * (0735-agent-queue-design/data/owner_wait_and_leak_check_1014_11kst.json). The chat
 * service marks the owner's own prompts with `pi-pool owner-turn`.
 */
// Six renewals per lease_s of 1,800 s, so a run that calls the model at least once per
// 25 minutes never lapses; the p99.9 gap between model calls was 1,508 s (base.py lease_s).
const QUEUE_RENEW_MS = 5 * 60_000;
const QUEUE_ENTRY = "pi-pool-queue";

interface AdmitReply { state: "admitted" | "queued" | "off" | "released"; kind: string | null; position: number | null; total: number | null }

function ordinal(n: number): string {
	const tens = n % 100;
	const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
	return `${n}${suffix}`;
}

/**
 * Waits for one run's slot inside the worker, with no process of its own. Until 10-16 each waiting run
 * spawned `admit --wait`, a Python process of about 30 MB that sat in the queue with it: at 09:10 KST, 49
 * of them held 1.5 GB while 68 turns waited. Now the first ask queues the run (its entry carries the
 * worker's pid, so the pool sweeps it if the worker dies), an unlocked read of turns.json each
 * WAIT_READ_MS sees the admit that another run's release or ask made, and a plain ask every WAIT_ASK_MS
 * keeps the place and runs an admit pass for slots that freed by a lapse. Resolves when the run may call
 * the model: admitted, the queue off, an error that leaves no entry in turns.json (fail open), or Stop, which drops the queue entry.
 * `onQueued` gets each queued answer.
 */
interface AdmitWait { result: Promise<AdmitReply | ParkReply | "stopped" | "failed">; cancel: () => void }
/** `pi-pool park` when the run parked: its entry keeps its place with no process until its slot or `retry_at` (epoch sec). */
interface ParkReply { state: "parked"; retry_at: number; position: number | null; total: number | null }

/**
 * A run still queued this long parks: its turn waits in Prime's credential wait until the pool wakes it at its slot, so
 * Prime can park the turn and let the worker go (pool/turns.py `park`). measured: of the 35,978 slot admits on us-metal02
 * from 10-24 00:00Z to 10-27 05:53Z the median wait was 135 s, 59% waited over 60 s, and those runs spent 89.5% of all
 * queued run-time past their first 60 s, with a median 382 s still to go. A park costs one session reload, median 0.2 s
 * and at most 23.7 s on 10-22.
 */
const PARK_AFTER_MS = 60_000;

/** Prime's per-session credential wait for the next model call, when this Prime has it. */
type CredentialWait = (retryAtMs: number, message: string) => void;
function credentialWait(ctx: ExtensionContext): CredentialWait | undefined {
	const api = ctx as ExtensionContext & { waitForCredential?: CredentialWait };
	return typeof api.waitForCredential === "function" ? api.waitForCredential.bind(api) : undefined;
}

const WAIT_READ_MS = 1000;
const WAIT_ASK_MS = 30_000;
const POOL_TURNS = join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "turns.json");

/** Where turns.json has `sid` now: working, queued, gone, or null when the file cannot be read. */
export function placeIn(text: string, sid: string): { part: "working" | "queued" | "gone"; kind: string | null } | null {
	try {
		const turns = JSON.parse(text) as { working?: Record<string, { kind?: unknown }>; queued?: Record<string, unknown> } | null;
		if (!turns || typeof turns !== "object") return null;
		const working = turns.working?.[sid];
		if (working) return { part: "working", kind: typeof working.kind === "string" ? working.kind : null };
		return { part: turns.queued?.[sid] ? "queued" : "gone", kind: null };
	} catch {
		return null;
	}
}

function readPlace(sid: string): ReturnType<typeof placeIn> {
	try {
		return placeIn(readFileSync(POOL_TURNS, "utf8"), sid);
	} catch {
		return null;
	}
}

/** The admit answer on the last line of the CLI's output, or null. */
export function admitReply(out: string): AdmitReply | null {
	try {
		const reply = JSON.parse(out.trim().split("\n").at(-1) ?? "") as AdmitReply;
		return typeof reply.state === "string" ? reply : null;
	} catch {
		return null;
	}
}

/**
 * Shows the wait in Prime's session lists and agent rosters, so a queued run reads as waiting and not as a model
 * stream. On 10-22 a chat stopped a queued child it took for a dead stream, which sent it to the back of a queue of
 * 179. ctx.setWaiting is Prime's API for this; a Prime without it shows the run as a model call, as before.
 */
function showWait(ctx: ExtensionContext, label: string | undefined): void {
	const api = ctx as ExtensionContext & { setWaiting?: (label: string | undefined) => void };
	if (typeof api.setWaiting === "function") api.setWaiting(label);
}

/**
 * Whether Prime holds input that starts the session's next run as soon as this one ends. A steer that arrives during a run
 * ends it after its model step, so a run cut that way ends with the steer still queued. On 10-22 the metal box owner
 * 01a11d24 got 3 runs from 09:57Z to 13:34Z, each after a wait of 2,802 s to 5,799 s at the back of the line, and each
 * held its slot for under 70 s.
 */
function inputQueued(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasPendingMessages();
	} catch {
		return false;
	}
}

function admitWait(sid: string, signal: AbortSignal | undefined, onQueued: (reply: AdmitReply) => void, canPark: boolean): AdmitWait {
	let cancel = () => {};
	const result = new Promise<AdmitReply | ParkReply | "stopped" | "failed">((resolve) => {
		const args = ["admit", sid];
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let askedAt = 0;
		let seen = 0;
		const queuedAt = Date.now();
		let parkAsked = !canPark;
		const finish = (result: AdmitReply | ParkReply | "stopped" | "failed") => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve(result);
		};
		let stopped = false;
		const stop = () => {
			if (done || stopped) return;
			stopped = true;
			void pool(["release", sid]).finally(() => finish("stopped"));
		};
		cancel = stop;
		signal?.addEventListener("abort", stop, { once: true });
		const ask = async (): Promise<boolean> => {
			askedAt = Date.now();
			const res = await pool(args);
			// A Stop that came while this ask ran released first; this ask may have queued the run again.
			if (stopped) {
				void pool(["release", sid]);
				return true;
			}
			const reply = admitReply(res.out);
			if (!res.ok || !reply) {
				// An ask fails when the pool flock stays busy past LOCK_TIMEOUT, which 1,161 vend_lock_busy
				// lines in the 14:00 KST hour of 10-16 show. Until then the run went on without a slot and its
				// queue entry stayed behind, to be admitted later with nobody on it for lease_s. A run whose
				// entry still stands keeps waiting on it.
				const place = readPlace(sid);
				if (place?.part === "working") {
					finish({ state: "admitted", kind: place.kind, position: null, total: null });
					return true;
				}
				if (place?.part === "queued") return false;
				finish("failed");
				return true;
			}
			if (reply.state === "queued") {
				onQueued(reply);
				return false;
			}
			finish(reply.state === "admitted" || reply.state === "off" ? reply : "failed");
			return true;
		};
		// One `park` per wait: an answer other than parked or admitted (a box that cannot wake, a failed run) leaves the run waiting here.
		const park = async (): Promise<boolean> => {
			parkAsked = true;
			const res = await pool(["park", sid]);
			if (stopped) return true;
			let reply: AdmitReply | ParkReply | null = null;
			try {
				reply = JSON.parse(res.out.trim().split("\n").at(-1) ?? "") as AdmitReply | ParkReply;
			} catch {
				return false;
			}
			if (!res.ok || !reply) return false;
			if (reply.state === "parked" && typeof reply.retry_at === "number") {
				finish(reply);
				return true;
			}
			if (reply.state === "admitted") {
				finish(reply);
				return true;
			}
			return false;
		};
		const tick = async () => {
			timer = undefined;
			if (done || stopped) return;
			if (signal?.aborted) return stop();
			if (!parkAsked && Date.now() - queuedAt >= PARK_AFTER_MS && await park()) return;
			if (done || stopped) return;
			let again = Date.now() - askedAt >= WAIT_ASK_MS;
			if (!again) {
				try {
					const mtime = statSync(POOL_TURNS).mtimeMs;
					if (mtime !== seen) {
						seen = mtime;
						const place = readPlace(sid);
						if (place?.part === "working") return finish({ state: "admitted", kind: place.kind, position: null, total: null });
						if (place?.part === "gone") again = true;
					}
				} catch {
					again = true;
				}
			}
			if (again && await ask()) return;
			if (!done) timer = setTimeout(() => void tick(), WAIT_READ_MS);
		};
		void ask().then((over) => {
			if (!over && !done) timer = setTimeout(() => void tick(), WAIT_READ_MS);
		});
	});
	return { result, cancel: () => cancel() };
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
	// The session's start work, which the first model call awaits (the `context` handler) and session_start does not: the
	// daemon answers a create only after every session_start handler, and on 10-20 this one held each Mac create about 1.1 s
	// (adopt-logins, then model, then who), while the first model call of a new thread came 0.3 s after the create's answer.
	let started: Promise<void> = Promise.resolve();
	pi.on("session_start", async (_event, ctx) => {
		clearTimers();
		started = (async () => {
			await adoptLogins(ctx);
			await recordModel(ctx);
			// Refusal check across the pool; the CLI rate-limits itself to once per 6h.
			void pool(["probe"]);
			if (!showsStatus(ctx)) return;
			await refreshStatus(ctx);
			// A widget set while the TUI client is still attaching can be dropped; set it again once attached.
			timers.push(setTimeout(() => void refreshStatus(ctx), 3000));
			timers.push(setInterval(() => void refreshStatus(ctx), STATUS_REFRESH_MS));
		})().catch(() => {});
	});
	// This session's place in the turn queue: no run yet, a run waiting for its slot, a
	// run that holds one, a run that goes without because the queue is off, or one that goes
	// without after a pool error and may have left a queue entry that agent_end releases.
	// "parked": the run gave up its place's process (pi-pool park) and waits in Prime's credential wait; it owes no release,
	// and its next model call asks again, which takes the slot the pool started for it.
	let slot: "none" | "held" | "free" | "failed" | "parked" | Promise<void> = "none";
	let cancelWait = () => {};
	let renewTimer: ReturnType<typeof setInterval> | undefined;
	let renewedAt = 0;
	// `next` says the session's next run starts at once, so the pool keeps this run's place in line for it. A pool CLI
	// from before --queued-input refuses the flag, and the plain release after it still frees the slot.
	const dropSlot = async (sid: string | undefined, next = false): Promise<void> => {
		const owes = slot === "held" || slot === "failed";
		if (typeof slot === "object") cancelWait();
		slot = "none";
		if (renewTimer) clearInterval(renewTimer);
		renewTimer = undefined;
		if (!owes || !sid) return;
		if (next && (await pool(["release", sid, "--queued-input"])).ok) return;
		await pool(["release", sid]);
	};
	const holdSlot = async (ctx: ExtensionContext): Promise<void> => {
		if (slot === "free" || slot === "failed") return;
		const sid = sessionId(ctx);
		if (slot === "held") {
			if (!sid || Date.now() - renewedAt < QUEUE_RENEW_MS) return;
			renewedAt = Date.now();
			await pool(["admit", sid, "--renew"]);
			return;
		}
		if (slot !== "none" && slot !== "parked") return slot;
		if (!sid) return;
		let told = false;
		const waitForCredential = credentialWait(ctx);
		const wait = admitWait(sid, ctx.signal, (reply) => {
			const { position, total } = reply;
			// A reload replaces this instance while its wait runs on; Prime then refuses the old pi and ctx, and the throw
			// was an unhandled rejection that ended Mac worker 6754cd3496ab at 15:44:57Z on 10-19. A stale instance stops its wait.
			try {
				if (position === null || total === null) return showWait(ctx, "a turn");
				showWait(ctx, `a turn, place ${position} of ${total}`);
				if (told) return;
				told = true;
				const text = `Queued for a working slot, ${ordinal(position)} of ${total}`;
				pi.appendEntry(QUEUE_ENTRY, { text, position, total, at: Date.now() });
				if (showsStatus(ctx)) ctx.ui.notify(`pi-pool: ${text}`, "info");
			} catch {
				wait.cancel();
			}
		}, waitForCredential !== undefined);
		cancelWait = wait.cancel;
		const waiting: Promise<void> = wait.result.then((result) => {
			try {
				showWait(ctx, undefined);
			} catch {
				// A replaced session's ctx throws, and Prime cleared its wait when the run ended.
			}
			if (slot !== waiting) return;
			if (result === "stopped") {
				slot = "none";
				return;
			}
			if (result !== "failed" && result.state === "parked") {
				slot = "parked";
				const place = result.position !== null && result.total !== null ? `, place ${result.position} of ${result.total}` : "";
				try {
					waitForCredential?.(result.retry_at * 1000, `pi-pool: this run waits for a working slot${place}; the pool wakes it when the slot starts, or it asks again at ${new Date(result.retry_at * 1000).toISOString()}.`);
				} catch {
					// A replaced session's ctx throws; its run is over, and the entry waits for the session's next ask.
				}
				return;
			}
			slot = result === "failed" ? "failed" : result.state === "admitted" ? "held" : "free";
			if (slot !== "held") return;
			renewedAt = Date.now();
			renewTimer = setInterval(() => {
				let idle = true;
				try {
					idle = ctx.isIdle();
				} catch {
					// A replaced session's ctx throws: its run is over.
				}
				if (idle) void dropSlot(sid);
			}, QUEUE_RENEW_MS);
		});
		slot = waiting;
		return waiting;
	};
	pi.on("context", async (_event, ctx) => {
		// The pool knows this session's model before it vends for the session's first request.
		await started;
		await holdSlot(ctx);
		return undefined;
	});
	pi.on("agent_end", async (_event, ctx) => dropSlot(sessionId(ctx), inputQueued(ctx)));
	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		const sid = sessionId(ctx);
		await dropSlot(sid);
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
		description: "Choose Auto pool selection or a Manual account for this session",
		getArgumentCompletions: async (): Promise<AutocompleteItem[]> => {
			// No ctx here, so the model's provider is unknown. Offer both pools.
			try {
				const listings = await Promise.all([...POOLED_PROVIDERS].map((provider) => listAccounts(provider, undefined)));
				const labels = listings.flatMap((listed) => (listed.ok ? listed.data.rows.map((row) => row.label) : []));
				return [...new Set(labels), FOLLOW].map((value) => ({ value, label: value === FOLLOW ? "Auto" : `Manual ${value}` }));
			} catch {
				return [{ value: FOLLOW, label: "Auto" }];
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
				const followLabel = "Auto (let the pool choose and switch accounts)";
				const trimmed = args.trim();
				let target: string;
				if (trimmed) {
					target = trimmed === FOLLOW ? FOLLOW : trimmed;
				} else {
					const rows = pickerRows(data.rows);
					const selection = data.selection;
					const selected = selection.mode === "manual"
						? rows.find((row) => row.id === selection.account_id)
						: rows.find((row) => row.current);
					const choice = await ctx.ui.select(`Account for this session (${provider}) · ${selectionName(data.selection, selected?.label)}`, [followLabel, ...rows.map((row) => rowLabel(row, provider))]);
					if (choice === undefined) return;
					target = choice === followLabel ? FOLLOW : (rows.find((row) => rowLabel(row, provider) === choice)?.id ?? choice);
				}
				await applyChoice(ctx, provider, sid, target);
			} catch (err) {
				ctx.ui.notify(`pi-pool /account failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

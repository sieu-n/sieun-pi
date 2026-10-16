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
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
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

/**
 * The Mac-wide turn queue (pool/turns.py). A run takes a working slot at its first
 * model call: the `context` handler awaits `admit --wait`, which Prime awaits with no
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

/** The parent's session id from its file's header line; the file name is not always the id. */
function parentSessionId(ctx: ExtensionContext): string | undefined {
	const header = ctx.sessionManager?.getHeader?.();
	const path = header?.parentSession;
	if (!path) return undefined;
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(4096);
			const n = readSync(fd, buf, 0, buf.length, 0);
			const id = (JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]) as { id?: unknown }).id;
			if (typeof id === "string" && id) return id;
		} finally {
			closeSync(fd);
		}
	} catch {
		// Fall back to the file name below.
	}
	return basename(path).replace(/\.jsonl$/, "");
}

/**
 * Waits for one run's slot inside the worker, with no process of its own. Until 10-16 each waiting run
 * spawned `admit --wait`, a Python process of about 30 MB that sat in the queue with it: at 09:10 KST, 49
 * of them held 1.5 GB while 68 turns waited. Now the first ask queues the run (its entry carries the
 * worker's pid, so the pool sweeps it if the worker dies), an unlocked read of state.json each
 * WAIT_READ_MS sees the admit that another run's release or ask made, and a plain ask every WAIT_ASK_MS
 * keeps the place and runs an admit pass for slots that freed by a lapse. Resolves when the run may call
 * the model: admitted, the queue off, an error that leaves no entry in state.json (fail open), or Stop, which drops the queue entry.
 * `onQueued` gets each queued answer.
 */
interface AdmitWait { result: Promise<AdmitReply | "stopped" | "failed">; cancel: () => void }

const WAIT_READ_MS = 1000;
const WAIT_ASK_MS = 30_000;
const POOL_STATE = join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "state.json");

/** Where state.json has `sid` now: working, queued, gone, or null when the file cannot be read. */
export function placeIn(text: string, sid: string): { part: "working" | "queued" | "gone"; kind: string | null } | null {
	try {
		const turns = (JSON.parse(text) as { turns?: { working?: Record<string, { kind?: unknown }>; queued?: Record<string, unknown> } }).turns;
		if (!turns) return null;
		const working = turns.working?.[sid];
		if (working) return { part: "working", kind: typeof working.kind === "string" ? working.kind : null };
		return { part: turns.queued?.[sid] ? "queued" : "gone", kind: null };
	} catch {
		return null;
	}
}

function readPlace(sid: string): ReturnType<typeof placeIn> {
	try {
		return placeIn(readFileSync(POOL_STATE, "utf8"), sid);
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

function admitWait(sid: string, parent: string | undefined, signal: AbortSignal | undefined, onQueued: (reply: AdmitReply) => void): AdmitWait {
	let cancel = () => {};
	const result = new Promise<AdmitReply | "stopped" | "failed">((resolve) => {
		const args = ["admit", sid, ...(parent ? ["--parent", parent] : [])];
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let askedAt = 0;
		let seen = 0;
		const finish = (result: AdmitReply | "stopped" | "failed") => {
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
		const tick = async () => {
			timer = undefined;
			if (done) return;
			if (signal?.aborted) return stop();
			let again = Date.now() - askedAt >= WAIT_ASK_MS;
			if (!again) {
				try {
					const mtime = statSync(POOL_STATE).mtimeMs;
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
	// This session's place in the turn queue: no run yet, a run waiting for its slot, a
	// run that holds one, a run that goes without because the queue is off, or one that goes
	// without after a pool error and may have left a queue entry that agent_end releases.
	let slot: "none" | "held" | "free" | "failed" | Promise<void> = "none";
	let cancelWait = () => {};
	let renewTimer: ReturnType<typeof setInterval> | undefined;
	let renewedAt = 0;
	const dropSlot = async (sid: string | undefined): Promise<void> => {
		const owes = slot === "held" || slot === "failed";
		if (typeof slot === "object") cancelWait();
		slot = "none";
		if (renewTimer) clearInterval(renewTimer);
		renewTimer = undefined;
		if (owes && sid) await pool(["release", sid]);
	};
	const holdSlot = async (ctx: ExtensionContext): Promise<void> => {
		if (slot === "free" || slot === "failed") return;
		const sid = sessionId(ctx);
		const parent = parentSessionId(ctx);
		if (slot === "held") {
			if (!sid || Date.now() - renewedAt < QUEUE_RENEW_MS) return;
			renewedAt = Date.now();
			await pool(["admit", sid, "--renew", ...(parent ? ["--parent", parent] : [])]);
			return;
		}
		if (slot !== "none") return slot;
		if (!sid) return;
		let told = false;
		const wait = admitWait(sid, parent, ctx.signal, (reply) => {
			if (told || reply.position === null || reply.total === null) return;
			told = true;
			const text = `Queued for a working slot, ${ordinal(reply.position)} of ${reply.total}`;
			pi.appendEntry(QUEUE_ENTRY, { text, position: reply.position, total: reply.total, at: Date.now() });
			if (showsStatus(ctx)) ctx.ui.notify(`pi-pool: ${text}`, "info");
		});
		cancelWait = wait.cancel;
		const waiting: Promise<void> = wait.result.then((result) => {
			if (slot !== waiting) return;
			if (result === "stopped") {
				slot = "none";
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
		await holdSlot(ctx);
		return undefined;
	});
	pi.on("agent_end", async (_event, ctx) => dropSlot(sessionId(ctx)));
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

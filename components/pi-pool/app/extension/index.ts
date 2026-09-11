/**
 * pi-pool /account, a thin picker over the pool CLI.
 *
 * This file draws nothing. The account row on the tray, the splash, and the
 * agents view comes from the bundle patch (`pi-pool patch`); an extension
 * cannot hold that row (ext-impl/virev/README.md section 4, auto-sns-agent).
 *
 * Every judgement lives in `pi-pool-token --cli`. This file parses one JSON
 * shape and formats strings, so the precedence rules and the usage math exist
 * once, in Python.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "prime-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `pi-pool patch` installs this directory as a symlink under <agent dir>/extensions,
// so the loader's own path points at the link, not at the pool.
const HERE = realpathSync(dirname(fileURLToPath(import.meta.url)));
const POOL_BIN = join(dirname(dirname(HERE)), "bin", "pi-pool-token");
const SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const POOLED_PROVIDERS = new Set(["anthropic", "openai-codex"]);
const FOLLOW = "follow";

/** One row of `pi-pool-token --cli ls --json`. The CLI owns every judgement in it. */
interface AccountRow {
	id: string; email: string; usage: string; session_pct: number; weekly_pct: number;
	usable: boolean; reason: string | null; current: boolean; pinned: boolean;
	force: boolean; live: boolean; seat: boolean; score: number | null;
	/** openai-codex only: free | plus | pro | team. The pool sends no plan for anthropic. */
	plan?: string;
}
interface CliListing {
	provider: string; session: string | null; patched: boolean;
	seat: { id: string; email: string } | null; rows: AccountRow[];
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

function sessionId(ctx: ExtensionCommandContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return id;
	} catch {
		// Fall through to the env var below.
	}
	const fromEnv = process.env[SESSION_ENV];
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
}

function rowLabel(row: AccountRow): string {
	const tags = [row.seat && "seat", row.pinned && "pinned", row.current && "current", row.reason, row.live && "live"]
		.filter((tag): tag is string => Boolean(tag));
	return `${row.email}  ${row.plan ? `${row.plan}  ` : ""}${row.usage}  [${tags.join("|")}]`;
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

async function applyChoice(ctx: ExtensionCommandContext, provider: string, sid: string | undefined, target: string, force: boolean): Promise<void> {
	const args = [...(target === FOLLOW ? ["use", "--follow"] : ["use", target]), "--provider", provider];
	if (sid) args.push("--session", sid);
	if (force) args.push("--force");
	const res = await pool(args);
	ctx.ui.notify(res.out || (res.ok ? "done" : "pi-pool use failed"), res.ok ? "info" : "error");
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("account", {
		description: "Switch the pooled account for this session",
		getArgumentCompletions: async (): Promise<AutocompleteItem[]> => {
			// No ctx here, so the model's provider is unknown. Offer both pools.
			try {
				const listings = await Promise.all([...POOLED_PROVIDERS].map((provider) => listAccounts(provider, undefined)));
				const emails = listings.flatMap((listed) => (listed.ok ? listed.data.rows.map((row) => row.email) : []));
				return [...new Set(emails), FOLLOW].map((value) => ({ value, label: value }));
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
				const followLabel = `Follow the pool (${data.seat ? data.seat.email : "no seat"})`;
				const trimmed = args.trim();
				let target: string;
				if (trimmed) {
					target = trimmed === FOLLOW ? FOLLOW : trimmed;
				} else {
					const choice = await ctx.ui.select(`Account for this session (${provider})`, [...data.rows.map(rowLabel), followLabel]);
					if (choice === undefined) return;
					target = choice === followLabel ? FOLLOW : (data.rows.find((row) => rowLabel(row) === choice)?.email ?? choice);
				}
				if (target !== FOLLOW) {
					const row = data.rows.find((candidate) => candidate.email === target);
					if (row && !row.usable) {
						const ok = await ctx.ui.confirm("Account not usable", `${target} is ${row.reason ?? "unusable"} right now. Pin it anyway?`);
						if (!ok) return;
						await applyChoice(ctx, provider, sid, target, true);
						return;
					}
				}
				await applyChoice(ctx, provider, sid, target, false);
			} catch (err) {
				ctx.ui.notify(`pi-pool /account failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

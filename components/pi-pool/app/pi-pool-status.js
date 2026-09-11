/**
 * pi-pool status for the Prime Agent TUI.
 *
 * Read-only view of the account pool, for the client process that draws the
 * tray line, the chat splash, and the agents view. Installed into
 * <prime-agent>/dist/bundle/pi-pool-status.js by `pi-pool patch`; the source
 * of truth is app/pi-pool-status.js in the maintained checkout.
 *
 * The tray shows what vend.py already vended, plus any pin that has not
 * landed yet. It never re-runs vend.py's resolve(); that would be a second
 * copy of the precedence chain, the usage math, and the DEFAULTS mirror,
 * which is the bug this file used to have.
 *
 * Inputs, all local files, re-read only when their mtime moves:
 *   ~/.config/tokenmaxxing/accounts.json        anthropic usage bars
 *   ~/.config/tokenmaxxing/codex-accounts.json   openai-codex usage bars
 *   ~/.config/pi-pool/state.json                 v2: providers[p], sessions[key]
 *   ~/.config/pi-pool/config.json                overrides of vend.py DEFAULTS
 *   ~/.prime/agent/models.json                   is a provider's apiKey the pool hook?
 *   ~/.prime/agent/auth.json                     a stored login (bypasses the pool on an unpatched daemon)
 *
 * state.json v2 keys sessions by the session-tree ROOT uuid (vend.py
 * SessionKey); the short active id is stored as sessions[uuid].active_id and
 * is advisory only, so every session lookup here tries the uuid first and
 * falls back to a scan by active_id.
 *
 * Nothing here may throw into a render: every export catches and returns
 * undefined / [] on failure. Nothing here writes, and nothing takes the pool
 * lock.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const POOL_DIR = process.env.PI_POOL_DIR || join(HOME, ".config", "pi-pool");
const TM_DIR = join(HOME, ".config", "tokenmaxxing");
const FIVE_H_MS = 5 * 3600 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const CODEX_SESSION_WINDOW_MAX_S = 6 * 3600;
const STAT_INTERVAL_MS = 1000;
const USAGE_STALE_AFTER_MS = 20 * 60 * 1000;
const DOT = "\xB7";

// Mirrors the four vend.py DEFAULTS the pool row still needs; config.json overrides win.
const DEFAULTS = {
	five_hour_max_pct: 95,
	seven_day_max_pct: 98,
	switch_models: ["fable"],
	session_penalty: 8,
};

function agentDir() {
	const env = process.env.PRIME_AGENT_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~/") ? join(HOME, env.slice(2)) : env;
	return join(HOME, ".prime", "agent");
}

/** path -> { checkedAt, mtimeMs, value } */
const fileCache = new Map();

function readJson(path) {
	const now = Date.now();
	const hit = fileCache.get(path);
	if (hit && now - hit.checkedAt < STAT_INTERVAL_MS) return hit.value;
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		fileCache.set(path, { checkedAt: now, mtimeMs, value: null });
		return null;
	}
	if (hit && hit.mtimeMs === mtimeMs) {
		hit.checkedAt = now;
		return hit.value;
	}
	let value = null;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		value = null;
	}
	fileCache.set(path, { checkedAt: now, mtimeMs, value });
	return value;
}

function config() {
	return { ...DEFAULTS, ...(readJson(join(POOL_DIR, "config.json")) ?? {}) };
}

// ---------------------------------------------------------------- usage math
// Same rules as vend.py live_pct / usage_pct / gated_pct / depleted / score.
function livePct(window, windowMs, sampledAtMs, nowMs) {
	if (!window) return 0;
	const pct = window.usedPercentage || 0;
	const resets = window.resetsAt;
	if (resets !== null && resets !== undefined) return resets <= nowMs ? 0 : pct;
	if (sampledAtMs && nowMs >= sampledAtMs + windowMs) return 0;
	return pct;
}

function resetIn(window, nowMs) {
	const resets = window?.resetsAt;
	if (resets === null || resets === undefined) return null;
	const left = (resets - nowMs) / 1000;
	return left > 0 ? left : null;
}

export function formatDuration(sec) {
	if (sec === null || sec === undefined) return "-";
	sec = Math.floor(sec);
	if (sec < 60) return "<1m";
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (d) return `${d}d${h}h`;
	if (h) return `${h}h${m}m`;
	return `${m}m`;
}

function gatedFamilies(account, cfg) {
	const out = [];
	const at = account.lastPerModelAt || account.lastUsageAt || 0;
	for (const [model, window] of Object.entries(account.lastPerModel ?? {})) {
		if (cfg.switch_models.some((f) => model.toLowerCase().includes(String(f).toLowerCase()))) {
			out.push({ model, window, at });
		}
	}
	return out;
}

// ---------------------------------------------------------- account normalizing
// Both providers land on one shape here, the same boundary vend.py draws
// (D5), so describeAccount, ranking, and score run unchanged for either.
function normalizeAnthropicAccount(a, cfg, nowMs) {
	const lu = a.lastUsage ?? {};
	const at = a.lastUsageAt || 0;
	const session = livePct(lu.fiveHour, FIVE_H_MS, at, nowMs);
	const weekly = livePct(lu.sevenDay, WEEK_MS, at, nowMs);
	let gated = 0;
	let gatedReset = null;
	for (const fam of gatedFamilies(a, cfg)) {
		const p = livePct(fam.window, WEEK_MS, fam.at, nowMs);
		if (p > gated || gatedReset === null) {
			gated = Math.max(gated, p);
			gatedReset = resetIn(fam.window, nowMs);
		}
	}
	return {
		provider: "anthropic", id: a.accountUuid, email: a.email,
		needsReauth: Boolean(a.needsReauth), sessionPct: session, weeklyPct: weekly, gatedPct: gated,
		sessionReset: resetIn(lu.fiveHour, nowMs), weeklyReset: resetIn(lu.sevenDay, nowMs), gatedReset,
		usageAt: at,
	};
}

/** The codex aggregate entry on the wanted side of the 6h line, closest to it. */
function codexWindow(account, above) {
	const items = account.lastUsage?.aggregate ?? [];
	const pool = items.filter((w) => (above ? w.windowSeconds > CODEX_SESSION_WINDOW_MAX_S : w.windowSeconds <= CODEX_SESSION_WINDOW_MAX_S));
	if (!pool.length) return null;
	pool.sort((x, y) => (above ? x.windowSeconds - y.windowSeconds : y.windowSeconds - x.windowSeconds));
	return pool[0];
}

function normalizeCodexAccount(a, nowMs) {
	const at = a.lastUsageAt || 0;
	const sessionWindow = codexWindow(a, false);
	const weeklyWindow = codexWindow(a, true);
	const session = sessionWindow ? livePct(sessionWindow, (sessionWindow.windowSeconds || 0) * 1000, at, nowMs) : 0;
	const weekly = weeklyWindow ? livePct(weeklyWindow, (weeklyWindow.windowSeconds || 0) * 1000, at, nowMs) : 0;
	return {
		provider: "openai-codex", id: a.accountId, email: a.email,
		needsReauth: Boolean(a.needsReauth), sessionPct: session, weeklyPct: weekly, gatedPct: 0,
		sessionReset: resetIn(sessionWindow, nowMs), weeklyReset: resetIn(weeklyWindow, nowMs), gatedReset: null,
		usageAt: at,
	};
}

function describeAccount(norm, cfg, providerState, activeId, nowMs) {
	const cooldownUntil = providerState.cooldowns?.[norm.id] ?? 0;
	const cooldownLeft = cooldownUntil * 1000 > nowMs ? cooldownUntil - nowMs / 1000 : 0;
	const depleted = norm.sessionPct >= cfg.five_hour_max_pct || norm.weeklyPct >= cfg.seven_day_max_pct || norm.gatedPct >= cfg.seven_day_max_pct;
	const usable = !norm.needsReauth && !depleted && cooldownLeft <= 0;
	return {
		...norm,
		cooldownLeft,
		depleted,
		usable,
		isLive: norm.id === activeId,
		isSeat: providerState.seat?.account_id === norm.id,
		isPoolPinned: providerState.pin === norm.id,
	};
}

// ------------------------------------------------------------------ snapshot
function emptyProviderState() {
	return { pin: null, seat: null, cooldowns: {} };
}

function buildSnapshot(nowMs, provider) {
	const cfg = config();
	const models = readJson(join(agentDir(), "models.json"));
	const hook = models?.providers?.[provider]?.apiKey;
	const configured = typeof hook === "string" && hook.startsWith("!") && hook.includes("pi-pool");
	const auth = readJson(join(agentDir(), "auth.json"));
	const storedLogin = auth?.[provider] ? { type: auth[provider].type } : null;
	const state = readJson(join(POOL_DIR, "state.json")) ?? {};
	const providerState = state.providers?.[provider] ?? emptyProviderState();
	const sessions = state.sessions ?? {};
	let accounts;
	if (provider === "anthropic") {
		const index = readJson(join(TM_DIR, "accounts.json")) ?? {};
		accounts = (index.accounts ?? []).map((a) => describeAccount(normalizeAnthropicAccount(a, cfg, nowMs), cfg, providerState, index.activeAccountUuid, nowMs));
	} else if (provider === "openai-codex") {
		const index = readJson(join(TM_DIR, "codex-accounts.json")) ?? {};
		accounts = (index.accounts ?? []).map((a) => describeAccount(normalizeCodexAccount(a, nowMs), cfg, providerState, index.activeAccountId, nowMs));
	} else {
		accounts = [];
	}
	const inUse = new Map();
	for (const rec of Object.values(sessions)) {
		const vend = rec.vends?.[provider];
		if (vend) inUse.set(vend.account_id, (inUse.get(vend.account_id) ?? 0) + 1);
	}
	for (const a of accounts) {
		a.sessions = inUse.get(a.id) ?? 0;
		a.score = a.usable ? Math.max(a.sessionPct, a.weeklyPct) + a.sessions * cfg.session_penalty : null;
	}
	const accountsById = new Map(accounts.map((a) => [a.id, a]));
	const seat = providerState.seat ? accountsById.get(providerState.seat.account_id) ?? null : null;
	const usable = accounts.filter((a) => a.usable);
	const next = usable.filter((a) => a.id !== seat?.id).sort((x, y) => x.score - y.score)[0] ?? null;
	const newestUsage = accounts.reduce((m, a) => Math.max(m, a.usageAt || 0), 0);
	return {
		provider, configured, hook: configured ? hook : null, storedLogin, cfg,
		accounts, accountsById, seat, usable, next, sessions,
		usageAgeMs: newestUsage ? nowMs - newestUsage : null,
		usageStale: newestUsage ? nowMs - newestUsage > USAGE_STALE_AFTER_MS : accounts.length > 0,
	};
}

const snapshotCache = new Map();

/**
 * One consistent read of one pool. Cached 1s per provider, same as before.
 * Reads accounts.json for anthropic and codex-accounts.json for openai-codex.
 */
export function poolSnapshot(provider) {
	const now = Date.now();
	const hit = snapshotCache.get(provider);
	if (hit && now - hit.at < STAT_INTERVAL_MS) return hit.value;
	let value = null;
	try {
		value = buildSnapshot(now, provider);
	} catch {
		value = null;
	}
	snapshotCache.set(provider, { at: now, value });
	return value;
}

// --------------------------------------------------------- per-session lookup
/** sessions[uuid] first (the hook's own key); active_id is advisory only. */
function resolveSessionRecord(snap, sessionId, sessionUuid) {
	if (!snap) return null;
	if (sessionUuid && snap.sessions[sessionUuid]) return snap.sessions[sessionUuid];
	if (sessionId) {
		for (const rec of Object.values(snap.sessions)) {
			if (rec.active_id === sessionId) return rec;
		}
	}
	return null;
}

/**
 * { hasVend, row, pin, pinRow, shadowedId, shadowRow, shadowReason } for one
 * session. Reads the last vend and the current pin off the session record;
 * never re-derives which account should have won.
 */
function sessionAccount(snap, sessionId, sessionUuid) {
	const rec = resolveSessionRecord(snap, sessionId, sessionUuid);
	const pin = rec?.pins?.[snap.provider] ?? null;
	const pinRow = pin ? snap.accountsById.get(pin.account_id) ?? null : null;
	const vend = rec?.vends?.[snap.provider] ?? null;
	if (!vend) {
		return { hasVend: false, row: snap.seat, pin, pinRow, shadowedId: null, shadowRow: null, shadowReason: null };
	}
	const [shadowedId, shadowReason] = vend.shadowed ?? [null, null];
	return {
		hasVend: true,
		row: snap.accountsById.get(vend.account_id) ?? null,
		pin, pinRow,
		shadowedId,
		shadowRow: shadowedId ? snap.accountsById.get(shadowedId) ?? null : null,
		shadowReason,
	};
}

// ------------------------------------------------------------- other providers
function jwtClaims(token) {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

/** prime-inference identity: one whoami call per key, never awaited by a render. */
const whoamiCache = new Map();
function primeInferenceEmail() {
	const key = readJson(join(HOME, ".prime", "config.json"))?.api_key;
	if (typeof key !== "string" || !key) return undefined;
	const hit = whoamiCache.get(key);
	if (hit) return hit.email;
	const entry = { email: undefined };
	whoamiCache.set(key, entry);
	fetch("https://api.primeintellect.ai/api/v1/user/whoami", {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: AbortSignal.timeout(5000),
	})
		.then((r) => (r.ok ? r.json() : null))
		.then((body) => {
			const email = body?.data?.email;
			entry.email = typeof email === "string" ? email : undefined;
		})
		.catch(() => {
			whoamiCache.delete(key);
		});
	return undefined;
}

// ------------------------------------------------------------------- formatting
function usageText(a) {
	return `${a.sessionPct}%/${a.weeklyPct}%`;
}

function flags(a) {
	const out = [];
	if (a.isPoolPinned) out.push("pool-pinned");
	if (a.needsReauth) out.push("needs re-auth");
	else if (a.depleted) out.push("depleted");
	if (a.cooldownLeft > 0) out.push(`cooldown ${formatDuration(a.cooldownLeft)}`);
	return out;
}

function emailOf(row, fallbackId) {
	return row ? row.email : fallbackId;
}

/**
 * The tray rule (sketch/tray.md): show what was vended, plus a pin that has
 * not landed yet. One comparison, never a second resolve().
 */
function sessionAccountLabel(sa) {
	if (!sa.hasVend) {
		// A pick made before the session's first request has no vend to compare
		// against, and showing the seat here would read as if the pick was lost.
		if (sa.pin) return `${emailOf(sa.pinRow, sa.pin.account_id)} (next request)`;
		return sa.row ? `${sa.row.email} ${usageText(sa.row)} seat` : undefined;
	}
	if (!sa.row) return undefined;
	if (sa.shadowedId) {
		return `${sa.row.email} ${usageText(sa.row)} ${DOT} pin ${emailOf(sa.shadowRow, sa.shadowedId)} ${sa.shadowReason ?? "unusable"}`;
	}
	if (sa.pin) {
		if (sa.pin.account_id === sa.row.id) return `${sa.row.email} ${usageText(sa.row)} pinned`;
		return `${emailOf(sa.pinRow, sa.pin.account_id)} (next request)`;
	}
	return `${sa.row.email} ${usageText(sa.row)}`;
}

/**
 * Short account text for the tray line, next to the model label. undefined
 * when there is nothing worth saying for this provider. sessionId is the
 * short active id, sessionUuid the session-tree root uuid; either may be
 * undefined, in which case the pool-wide seat is described.
 */
export function trayAccountLabel(provider, sessionId, sessionUuid) {
	try {
		if (provider === "anthropic" || provider === "openai-codex") {
			const snap = poolSnapshot(provider);
			if (!snap?.configured) {
				if (provider === "openai-codex") {
					const entry = readJson(join(agentDir(), "auth.json"))?.["openai-codex"];
					const email = jwtClaims(entry?.access)?.["https://api.openai.com/profile"]?.email;
					return typeof email === "string" ? `${email} login` : undefined;
				}
				return snap?.storedLogin ? `login (${snap.storedLogin.type})` : undefined;
			}
			const label = sessionAccountLabel(sessionAccount(snap, sessionId, sessionUuid));
			if (!label) return snap.storedLogin ? `pool: unset ${DOT} login in auth.json` : "pool: unset";
			return snap.storedLogin ? `${label} ${DOT} login in auth.json` : label;
		}
		if (provider === "prime-inference") {
			return primeInferenceEmail();
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Splash metadata rows ({label, value}) for the chat header and the agents
 * view. Two rows at most, so the ten-row logo still fits every row.
 */
export function splashMetadata(provider, sessionId, sessionUuid) {
	try {
		const rows = [];
		const account = trayAccountLabel(provider, sessionId, sessionUuid);
		if (account) rows.push({ label: "account", value: account });
		if (provider !== "anthropic" && provider !== "openai-codex") return rows;
		const snap = poolSnapshot(provider);
		if (!snap?.configured) return rows;
		const bits = [`${snap.usable.length}/${snap.accounts.length} usable`];
		if (snap.seat) bits.push(`seat ${snap.seat.email}`);
		if (snap.next) bits.push(`next ${snap.next.email} ${usageText(snap.next)}`);
		const reauth = snap.accounts.filter((a) => a.needsReauth).length;
		if (reauth) bits.push(`${reauth} need re-auth`);
		if (snap.usageStale) bits.push(snap.usageAgeMs === null ? "no usage data" : `usage ${formatDuration(snap.usageAgeMs / 1000)} old`);
		rows.push({ label: "pool", value: bits.join(` ${DOT} `) });
		return rows;
	} catch {
		return [];
	}
}

/**
 * Problems worth a line under the agents view header. Empty when both pools
 * are healthy. Plain strings; the caller styles them. Checks every
 * configured provider, since the header shows only one row's provider but a
 * notice is worth raising regardless of which model is selected.
 */
export function noticeLines(sessionId, sessionUuid) {
	try {
		const out = [];
		for (const provider of ["anthropic", "openai-codex"]) {
			const snap = poolSnapshot(provider);
			if (!snap?.configured) continue;
			if (snap.storedLogin) {
				out.push(`pi-pool: auth.json holds a ${provider} login. A patched daemon ignores it; an unpatched one uses it instead of the pool. Fix: pi-pool patch`);
			}
			const sa = sessionAccount(snap, sessionId, sessionUuid);
			if (sa.hasVend && sa.shadowedId) {
				out.push(`pi-pool: ${provider} pin ${emailOf(sa.shadowRow, sa.shadowedId)} is ${sa.shadowReason ?? "unusable"}; moved to ${sa.row ? `${sa.row.email} ${usageText(sa.row)}` : "nothing (no usable account)"}`);
			} else if (snap.usable.length === 0) {
				out.push(`pi-pool: no usable ${provider} account in the pool`);
			}
			if (snap.usageStale) {
				out.push(`pi-pool: ${provider} usage snapshot is ${snap.usageAgeMs === null ? "missing" : `${formatDuration(snap.usageAgeMs / 1000)} old`}; check the com.tokenmaxxing.check LaunchAgent`);
			}
		}
		return out.slice(0, 2);
	} catch {
		return [];
	}
}

/** Full table, `pi-pool status` shaped, for a wider surface such as a modal. */
export function tableLines(provider, sessionId, sessionUuid) {
	try {
		const snap = poolSnapshot(provider);
		if (!snap?.configured) return [`pi-pool is not the ${provider} apiKey in models.json`];
		const sa = sessionAccount(snap, sessionId, sessionUuid);
		const who = sa.hasVend && sa.pin && sa.row && sa.pin.account_id === sa.row.id ? `${sa.row.email} (pinned)` : snap.seat ? snap.seat.email : "unset";
		const lines = [`seat ${who} ${DOT} ${snap.usable.length}/${snap.accounts.length} usable`];
		for (const a of snap.accounts) {
			const liveTag = a.isLive ? (provider === "openai-codex" ? "codex-live" : "claude-code-live") : "";
			const tags = [a.isSeat ? "seat" : "", liveTag, ...flags(a)].filter(Boolean);
			lines.push(`${a.email.padEnd(26)} 5h ${String(a.sessionPct).padStart(3)}% ${formatDuration(a.sessionReset).padEnd(6)} 7d ${String(a.weeklyPct).padStart(3)}% ${formatDuration(a.weeklyReset).padEnd(6)} ${tags.join(" ") || "available"}`);
		}
		return lines;
	} catch {
		return [];
	}
}

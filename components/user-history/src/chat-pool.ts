import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AccountAction, AccountLogin, AccountsView, PoolAccount, PoolProvider, PoolResolution, PoolWindow } from "./shared/types.ts";

/** The pi-pool CLI next to this component; PI_POOL_BIN names another one (the native test runs a recording fake). */
const executable = process.env.PI_POOL_BIN ?? fileURLToPath(new URL("../../pi-pool/bin/pi-pool", import.meta.url));
export const pooledProviders = ["anthropic", "openai-codex"] as const;
type PooledProvider = typeof pooledProviders[number];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const isPooled = (value: string): value is PooledProvider => (pooledProviders as readonly string[]).includes(value);
const epochMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const WINDOW_KINDS = new Set<unknown>(["session", "weekly", "model"]);

function parseWindows(value: unknown): PoolWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): PoolWindow[] => {
    if (!isRecord(entry) || !WINDOW_KINDS.has(entry.kind) || typeof entry.label !== "string") return [];
    return [{ kind: entry.kind as PoolWindow["kind"], label: entry.label, pct: percent(entry.pct) ?? 0, resetsAt: epochMs(entry.resets_at) }];
  });
}

export function parsePoolRows(value: unknown, provider: string): PoolAccount[] {
  if (!isRecord(value) || value.provider !== provider || !Array.isArray(value.rows)) throw new Error("pi-pool returned an invalid listing");
  return value.rows.map((row: unknown): PoolAccount => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.email !== "string" || typeof row.usage !== "string" ||
      !(row.reason === null || typeof row.reason === "string") || typeof row.usable !== "boolean" || typeof row.current !== "boolean" ||
      typeof row.pinned !== "boolean" || typeof row.force !== "boolean" || typeof row.live !== "boolean" || typeof row.seat !== "boolean") {
      throw new Error("pi-pool returned an invalid account");
    }
    return { id: row.id, email: row.email, usage: row.usage, reason: row.reason, usable: row.usable, current: row.current, pinned: row.pinned, force: row.force,
      live: row.live, seat: row.seat, session_pct: percent(row.session_pct), weekly_pct: percent(row.weekly_pct), score: percent(row.score),
      ...(typeof row.plan === "string" ? { plan: row.plan } : {}),
      tier: text(row.tier), windows: parseWindows(row.windows), usageAt: epochMs(row.usage_at), cooldownUntil: epochMs(row.cooldown_until),
      cooldownReason: text(row.cooldown_reason), disabled: row.disabled === true };
  });
}

export function parsePoolResolution(value: unknown, provider: string): PoolResolution | null {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid resolution");
  const selected = value.providers[provider];
  if (!isRecord(selected) || "error" in selected) return null;
  return { account: typeof selected.account === "string" ? selected.account : null, email: typeof selected.email === "string" ? selected.email : null,
    reason: typeof selected.reason === "string" ? selected.reason : null, pinned: selected.pinned === true };
}

/** pi-pool reads the calling session from these variables. The service may have been started inside a session; a thread is always named with --session instead. */
const SESSION_VARIABLES = ["PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"];
const poolEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.includes(name)));

function reportedError(stdout: string): string | null {
  try { const value: unknown = JSON.parse(stdout); return isRecord(value) ? text(value.error) : null; } catch { return null; }
}

function run(args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: poolEnv() }, (error, stdout, stderr) => {
      if (error) { reject(new Error("pi-pool failed: " + (String(stderr).trim() || reportedError(String(stdout)) || error.message).slice(0, 300))); return; }
      resolve(stdout);
    });
  });
}

const session = (sessionId: string | null) => sessionId ? ["--session", sessionId] : [];

export async function listAccounts(sessionId: string | null): Promise<AccountsView> {
  const resolution = await run(["who", "--json", ...session(sessionId)]).then(JSON.parse).catch(() => null);
  const providers = await Promise.all(pooledProviders.map(async (provider): Promise<PoolProvider> => {
    try {
      const listing: unknown = JSON.parse(await run(["ls", "--json", "--provider", provider, ...session(sessionId)]));
      if (isRecord(listing) && typeof listing.error === "string") return { provider, rows: [], resolution: null, error: listing.error };
      const poolPin = isRecord(listing) && isRecord(listing.pin) ? text(listing.pin.id) : null;
      return { provider, rows: parsePoolRows(listing, provider), resolution: resolution ? parsePoolResolution(resolution, provider) : null, poolPin };
    } catch (error) { return { provider, rows: [], resolution: null, error: error instanceof Error ? error.message : String(error) }; }
  }));
  return { sessionId, checkedAt: new Date().toISOString(), providers };
}

/** One sentence from `pi-pool refresh --json`: which accounts tokenmaxxing could not read. */
export function refreshNotice(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid refresh report");
  const rows = Object.values(value.providers).flatMap(rows => Array.isArray(rows) ? rows.filter(isRecord) : []);
  const failed = rows.filter(row => row.ok !== true);
  if (!failed.length) return rows.length === 1 ? "Usage updated." : `Usage updated for ${rows.length} accounts.`;
  return `Usage updated for ${rows.length - failed.length} of ${rows.length} accounts. ` +
    failed.map(row => `${text(row.email) ?? "An account"}: ${text(row.reason) ?? "not read"}.`).join(" ");
}

/** The pi-pool command lines this service runs for account changes. A CLI contract change is a one-line fix here. */
export const poolCommand = {
  disable: (provider: string, account: string) => ["off", account, "--provider", provider],
  enable: (provider: string, account: string) => ["on", account, "--provider", provider],
  remove: (provider: string, account: string) => ["rm", account, "--provider", provider],
  login: (provider: string, account: string | null, seconds: number) => ["login", ...(account ? [account] : []), "--provider", provider, "--timeout", String(seconds)],
};

const accountArgument = (account: string | undefined): string => {
  if (!account || account.startsWith("-")) throw new Error("Choose an account.");
  return account;
};

/** Runs one pool action. Returns a sentence to show when the action reports something beyond the new pool state. */
export async function runAccountAction(action: AccountAction): Promise<string | null> {
  if (!isPooled(action.provider)) throw new Error("Choose a pooled provider.");
  const provider = ["--provider", action.provider];
  switch (action.action) {
    case "use": {
      if (!action.account || action.account.startsWith("-") || !action.id) throw new Error("Choose an account and a thread.");
      await run(["use", action.account, ...(action.force ? ["--force"] : []), ...provider, "--session", action.id]); return null;
    }
    case "follow": {
      if (!action.id) throw new Error("Choose a thread.");
      await run(["use", "--follow", ...provider, "--session", action.id]); return null;
    }
    case "pin": await run(["pin", accountArgument(action.account), ...provider]); return null;
    case "unpin": await run(["unpin", ...provider]); return null;
    case "switch": await run(["switch", ...provider]); return null;
    case "disable": await run(poolCommand.disable(action.provider, accountArgument(action.account))); return null;
    case "enable": await run(poolCommand.enable(action.provider, accountArgument(action.account))); return null;
    case "remove": await run(poolCommand.remove(action.provider, accountArgument(action.account)), 75000); return null;
    case "refresh": return refreshNotice(JSON.parse(await run(["refresh", "--json"], 75000)));
    case "recheck": {
      if (action.provider !== "anthropic") throw new Error("Only Claude accounts can be checked for a refusal.");
      const found = (await run(["probe", "--force"], 30000)).trim();
      return found ? found.replaceAll("; ", ". ") + "." : "No refusals found.";
    }
  }
}

export class PoolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One stdout line of `pi-pool login`, parsed at the boundary. Links that are not https are dropped, so the page only ever links to a provider. */
export type LoginEvent = { event: "url"; url: string | null; manualUrl: string | null; code: string | null; paste: boolean }
  | { event: "retry"; message: string } | { event: "done"; ok: boolean; message: string };

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
};

export function parseLoginEvent(line: string): LoginEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  switch (value.event) {
    case "url": return { event: "url", url: httpsUrl(value.url), manualUrl: httpsUrl(value.manual_url), code: text(value.code), paste: value.paste === true };
    case "retry": return { event: "retry", message: text(value.message) ?? "That code was not accepted. Open the new link and try again." };
    case "done": return { event: "done", ok: value.ok === true, message: text(value.message) ?? (value.ok === true ? "Signed in." : "The sign-in failed.") };
    default: return null;
  }
}

const TERMINAL = new Set<AccountLogin["status"]>(["done", "failed", "cancelled"]);
export const loginRunning = (login: AccountLogin | null): boolean => login !== null && !TERMINAL.has(login.status);

/**
 * Runs one `pi-pool login` at a time for the browser: add an account, or sign one in again.
 * The child gets `--timeout` and this class still kills it at its own deadline. Closing its stdin cancels, SIGTERM stops it,
 * SIGKILL follows after a grace period. The last login stays readable after it ends, so a page opened later sees the result.
 */
export class AccountLogins {
  private login: AccountLogin | null = null;
  private child: ChildProcess | null = null;
  private stopping: "cancel" | "deadline" | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly listeners = new Set<(login: AccountLogin | null) => void>();
  private readonly executable: string;
  private readonly deadlineMs: number;
  private readonly graceMs: number;

  constructor(options: { executable?: string; deadlineMs?: number; graceMs?: number } = {}) {
    this.executable = options.executable ?? executable;
    this.deadlineMs = options.deadlineMs ?? 10 * 60_000;
    this.graceMs = options.graceMs ?? 10_000;
  }

  current(): AccountLogin | null { return this.login; }

  subscribe(listener: (login: AccountLogin | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.login);
    return () => { this.listeners.delete(listener); };
  }

  start(provider: string, account: string | null): AccountLogin {
    if (!isPooled(provider)) throw new PoolError(400, "Choose a pooled provider.");
    if (account !== null && (!account || account.startsWith("-") || account.length > 256)) throw new PoolError(400, "Choose an account.");
    if (loginRunning(this.login)) throw new PoolError(409, "Another sign-in is still running. Finish or cancel it first.");
    const seconds = Math.max(1, Math.floor(this.deadlineMs / 1000));
    const child = spawn(this.executable, poolCommand.login(provider, account, seconds), { env: poolEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stopping = null;
    this.update({ id: randomUUID(), provider, account, status: "starting", url: null, manualUrl: null, code: null, paste: false, message: null });
    let stdout = "";
    let stderr = "";
    let finished: LoginEvent & { event: "done" } | null = null;
    child.stdin!.on("error", () => {});
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const event = parseLoginEvent(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        if (event?.event === "done") finished = event;
        else if (event) this.apply(child, event);
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", error => { stderr = error.message; });
    child.once("close", code => {
      if (this.child !== child) return;
      this.child = null;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
      const done: LoginEvent & { event: "done" } | null = finished;
      const said = stderr.trim().split("\n").at(-1)?.slice(0, 300);
      const next: Pick<AccountLogin, "status" | "message"> =
        this.stopping === "deadline" ? { status: "failed", message: `The sign-in did not finish in ${Math.round(this.deadlineMs / 60_000) || 1} min.` }
        : this.stopping === "cancel" && !done?.ok ? { status: "cancelled", message: null }
        : done ? { status: done.ok ? "done" : "failed", message: done.message }
        : { status: "failed", message: said || `pi-pool login stopped with exit code ${code ?? "none"}.` };
      if (this.login) this.update({ ...this.login, ...next, paste: false });
    });
    this.timers.push(setTimeout(() => this.stop(child, "deadline"), this.deadlineMs + this.graceMs));
    return this.login!;
  }

  paste(id: string, code: string): AccountLogin {
    const login = this.running(id);
    const line = code.trim();
    if (!line || line.length > 4096 || /[\r\n]/.test(line)) throw new PoolError(400, "Paste the sign-in code as one line.");
    if (!login.paste) throw new PoolError(409, "This sign-in does not take a pasted code.");
    this.child?.stdin?.write(line + "\n");
    return this.update({ ...login, status: "finishing", message: null });
  }

  cancel(id: string): AccountLogin {
    const login = this.running(id);
    if (this.child) this.stop(this.child, "cancel");
    return login;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    this.stop(child, "cancel");
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, this.graceMs * 2 + 1000))]);
  }

  private running(id: string): AccountLogin {
    if (!this.login || this.login.id !== id || !loginRunning(this.login)) throw new PoolError(404, "This sign-in has ended.");
    return this.login;
  }

  /** Close stdin (pi-pool's cancel), then SIGTERM after the grace period, then SIGKILL. Idempotent: a second call only upgrades a cancel to a deadline. */
  private stop(child: ChildProcess, why: "cancel" | "deadline"): void {
    if (this.child !== child) return;
    const first = this.stopping === null;
    if (why === "deadline" || first) this.stopping = why;
    if (!first) return;
    child.stdin?.end();
    this.timers.push(setTimeout(() => child.kill("SIGTERM"), why === "deadline" ? 0 : this.graceMs));
    this.timers.push(setTimeout(() => child.kill("SIGKILL"), this.graceMs * 2));
  }

  private apply(child: ChildProcess, event: LoginEvent): void {
    if (this.child !== child || !this.login || this.stopping) return;
    if (event.event === "url") this.update({ ...this.login, status: "waiting", url: event.url ?? event.manualUrl, manualUrl: event.manualUrl, code: event.code, paste: event.paste, message: null });
    else if (event.event === "retry") this.update({ ...this.login, status: "starting", url: null, manualUrl: null, code: null, message: event.message });
  }

  private update(login: AccountLogin): AccountLogin {
    this.login = login;
    for (const listener of this.listeners) listener(login);
    return login;
  }
}

/**
 * The Accounts tab's endpoints (apps/chat/API.md, "Accounts"). Every pi-pool call runs through the old chat's own code in
 * legacy/prime/user-history/src/chat-pool.ts, so the pool's parsers, its shared reader and its login and refresh runners live in one place.
 * A thread is any sw factory id: a conversation id, an agent id `ag_<slug>` or a DM room `dm_<slug>`. pi-pool knows it as the tree of its
 * root thread, `pi-durable:<root thread id>`, or for a comm thread its agent's work thread's (packages/pi-host/src/durable/pool-labels.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountLogins, forgetAccountReadings, listAccounts, poolExecutable, PoolError, readNoModelRoom, runAccountAction, setNoModelRoom, setPoolPriority, UsageRefreshes,
} from "../../../legacy/prime/user-history/src/chat-pool.ts";
import { NO_MODEL_ROOM, POOL_PRIORITIES, type AccountAction, type AccountsView, type AccountThread, type NoModelRoom, type PoolPriority } from "../web/src/lib/api/shared/types.ts";
import type { App } from "./app.ts";
import { fakePoolState, reseedFakePool, useFakePool } from "./fixture/pool.ts";
import { parseConversationId } from "./threads.ts";

export { PoolError };

type Handler = (req: IncomingMessage, params: Record<string, string>, query: URLSearchParams, body: () => Promise<unknown>) => Promise<unknown>;

/** What pi-pool says for a tree it has no record of: one that never sent a request. */
const NO_RECORD = /matches no known session/;
const NO_RECORD_VIEW = "This thread has sent no request yet, so the pool has no record of it. Its first request takes the account Auto picks.";
const NO_RECORD_ACTION = "This thread has sent no request yet, so the pool has no record to keep a pick or a class on. Send it a message first, then choose again.";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new PoolError(400, `${name} must be a string of 1 to ${max} characters.`);
  return value.trim();
}

const optional = (value: unknown, name: string, max: number): string | null => (value === undefined || value === null ? null : text(value, name, max));

/**
 * The pool tree of a sw factory thread id. An agent or DM reads as the agent's work thread, any conversation as its root thread, and a comm
 * thread as its agent's work thread, whose tree pi-host runs it in (packages/pi-host/src/durable/pool-labels.ts).
 */
export function poolTree(app: App, id: string): string {
  const root = parseConversationId(app.threads.conversationOf(id)).thread;
  if (!app.threads.thread(root)) throw new PoolError(404, `No thread ${id}.`);
  return `pi-durable:${app.agents.ofComm(root)?.record.workThread ?? root}`;
}

/** A POST body as an account action, with `use` and `follow` naming a sw factory thread in `id`. Ported from the old chat-server.ts parseAccountAction. */
function parseAction(body: Record<string, unknown>): AccountAction {
  const provider = text(body.provider, "provider", 64);
  const account = optional(body.account, "account", 256) ?? undefined;
  const id = optional(body.id, "id", 256) ?? undefined;
  switch (body.action) {
    case "use": if (!account || !id) throw new PoolError(400, "Choose an account and a thread."); return { action: "use", provider, account, id };
    case "follow": if (!id) throw new PoolError(400, "Choose a thread."); return { action: "follow", provider, id };
    case "pin": if (!account) throw new PoolError(400, "Choose an account."); return { action: "pin", provider, account };
    case "unpin": return { action: "unpin", provider };
    case "switch": return { action: "switch", provider };
    case "recheck": return { action: "recheck", provider };
    case "resets": return { action: "resets", provider, ...(account ? { account } : {}) };
    case "reset": {
      if (!account) throw new PoolError(400, "Choose an account.");
      const grant = optional(body.grant, "grant", 40);
      return { action: "reset", provider, account, ...(grant ? { grant } : {}) };
    }
    case "disable": case "enable": case "remove":
      if (!account) throw new PoolError(400, "Choose an account.");
      return { action: body.action, provider, account };
    default: throw new PoolError(400, "Unknown account action.");
  }
}

/** Which client asked, for the service log: its address and user agent. The pool's own log names no caller. */
const caller = (req: IncomingMessage): string => `from ${req.socket.remoteAddress ?? "-"} (${String(req.headers["user-agent"] ?? "-").slice(0, 80)})`;

/** One service log line per action: what, on which account and thread, and which client asked. */
export function actionLine(action: AccountAction, tree: string | null, req: IncomingMessage): string {
  const account = "account" in action && action.account ? ` ${action.account}` : "";
  const thread = "id" in action ? ` on ${action.id}${tree ? ` (${tree})` : ""}` : "";
  return `accounts: ${action.action}${account} (${action.provider})${thread} ${caller(req)}`;
}

/** A pi-pool failure is the caller's to see: 400 with the pool's message, or a PoolError's own status. */
const asPoolError = (error: unknown): PoolError =>
  error instanceof PoolError ? error : new PoolError(400, error instanceof Error ? error.message : String(error));

/**
 * The names people give accounts in sw factory, keyed `<provider>:<account id>` in `<dataDir>/account-names.json`. pi-pool keeps no name of
 * its own (an account's label is its email), so a rename never touches the pool's files.
 */
export class AccountNames {
  private names: Record<string, string>;
  constructor(private readonly file: string) {
    this.names = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  }

  get(provider: string, account: string): string | null {
    return this.names[`${provider}:${account}`] ?? null;
  }

  /** Sets the name, or clears it with null or an empty string. */
  set(provider: string, account: string, name: string | null): void {
    const key = `${provider}:${account}`;
    if (name?.trim()) this.names[key] = name.trim();
    else delete this.names[key];
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.names, null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
  }

  /** Drops every name, for the fixture's reset. */
  clear(): void {
    this.names = {};
    if (existsSync(this.file)) writeFileSync(this.file, "{}\n");
  }

  /** The view with each row's `name`. */
  apply(view: AccountsView): AccountsView {
    return { ...view, providers: view.providers.map(entry => ({ ...entry, rows: entry.rows.map(row => ({ ...row, name: this.get(entry.provider, row.id) })) })) };
  }
}

/** pi-pool's state file, read-only: `$PI_POOL_DIR/state.json`, else `~/.config/pi-pool/state.json`, as pool/base.py finds it. */
const poolStateFile = (): string => join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "state.json");

interface PoolVend { account_id?: string; at?: number; from?: number; n?: number }

/**
 * The threads whose last request on `provider` went to `account` within `windowSec`, newest first, from the `vends` of pi-pool's session
 * records. This is the same rule pi-pool's sched.in_use_counts uses for a row's thread count. A `pi-durable:<thread>` tree opens in sw factory:
 * an agent's work thread as its DM, any other thread as its conversation. Any other tree is a Prime session.
 */
export function accountThreads(app: App, provider: string, account: string, windowSec: number, now = Date.now() / 1000): AccountThread[] {
  const file = poolStateFile();
  if (!existsSync(file)) return [];
  const sessions = (JSON.parse(readFileSync(file, "utf8")) as { sessions?: Record<string, { vends?: Record<string, PoolVend> }> }).sessions ?? {};
  const out: AccountThread[] = [];
  for (const [tree, record] of Object.entries(sessions)) {
    const vend = record.vends?.[provider];
    if (vend?.account_id !== account || !vend.at || now - vend.at > windowSec) continue;
    const thread = tree.startsWith("pi-durable:") ? tree.slice("pi-durable:".length) : null;
    const agent = thread ? app.threads.registered(thread) : undefined;
    const row = thread ? app.threads.thread(thread) : undefined;
    out.push({
      tree,
      name: agent?.name ?? row?.name ?? (thread ? `Thread ${thread.slice(0, 8)}` : `Prime session ${tree.slice(0, 8)}`),
      href: agent ? `#/c/${agent.room}` : thread ? `#/c/${thread}` : null,
      at: vend.at * 1000, since: vend.from ? vend.from * 1000 : null, requests: vend.n ?? null,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The view of a tree, or of no tree. A tree with no record yet reads as the pool with no thread, with a sentence that says why, since pi-pool
 * answers every read of it with an error.
 */
async function poolView(tree: string | null, model: string | null, fresh: boolean): Promise<AccountsView> {
  const view = await listAccounts(tree, model, { fresh });
  if (!tree || !hasNoRecord(view)) return view;
  const pool = await listAccounts(null, model, { fresh });
  return {
    ...pool, sessionId: tree, priority: null,
    providers: pool.providers.map(entry => ({ ...entry, wait: null, resolution: entry.resolution && { ...entry.resolution, error: NO_RECORD_VIEW } })),
  };
}

/**
 * The view of a box with no pi-pool CLI, or undefined when the CLI is there. A compose dev instance has none (its pi-host takes an API key,
 * or the box's pool through deploy/compose/compose.pool.yaml), and every pool read there failed with ENOENT, which the page showed as
 * "Accounts unavailable" on every DM.
 */
function noPool(): AccountsView | undefined {
  return existsSync(poolExecutable()) ? undefined : { sessionId: null, checkedAt: new Date().toISOString(), providers: [], poolConfig: null, absent: true };
}

const hasNoRecord = (view: AccountsView): boolean => view.providers.every(entry => NO_RECORD.test(entry.error ?? ""));

/** Turns a failed tree write into a plain sentence when the reason is that the tree has no record yet. */
async function treeWrite(tree: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const view = await listAccounts(tree, null, { fresh: true }).catch(() => null);
    throw view && hasNoRecord(view) ? new PoolError(409, NO_RECORD_ACTION) : asPoolError(error);
  }
}

/** Answers any failure of `handler` as a PoolError, which the HTTP layer sends with its own status. */
const handled = (handler: Handler): Handler => async (...args) => {
  try {
    return await handler(...args);
  } catch (error) {
    throw asPoolError(error);
  }
};

async function object(body: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const value = await body();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PoolError(400, "The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function accountRoutes<R>(app: App, route: (method: string, path: string, handler: Handler) => R): R[] {
  if (app.config.fixture) useFakePool(app.config.dataDir, app.threads.threadsList().map(thread => thread.id));
  const logins = new AccountLogins();
  const refreshes = new UsageRefreshes();
  const names = new AccountNames(join(app.config.dataDir, "account-names.json"));
  const accountsView = async (tree: string | null, model: string | null, fresh: boolean): Promise<AccountsView> => names.apply(await poolView(tree, model, fresh));
  return [
    route("GET", "/api/pool", handled(async () => noPool() ?? names.apply(await listAccounts(null)))),
    route("GET", "/api/accounts", handled(async (_r, _p, q) => {
      const absent = noPool();
      if (absent) return absent;
      const thread = q.get("thread");
      return accountsView(thread ? poolTree(app, thread) : null, optional(q.get("model") || null, "model", 256), q.get("fresh") === "1");
    })),
    route("POST", "/api/accounts/name", handled(async (req, _p, _q, body) => {
      const input = await object(body);
      const provider = text(input.provider, "provider", 64);
      const account = text(input.account, "account", 256);
      const name = input.name === null || input.name === "" ? null : text(input.name, "name", 80);
      const view = await listAccounts(null);
      if (!view.providers.some(entry => entry.provider === provider && entry.rows.some(row => row.id === account))) throw new PoolError(404, "No such account.");
      names.set(provider, account, name);
      app.log(`accounts: name ${account} (${provider}) ${name === null ? "cleared" : "set"} ${caller(req)}`);
      return names.apply(view);
    })),
    route("GET", "/api/accounts/threads", handled(async (_r, _p, q) => {
      const view = await listAccounts(null);
      const windowSec = Number(view.poolConfig?.["active_session_sec"] ?? 3600);
      return { threads: accountThreads(app, text(q.get("provider"), "provider", 64), text(q.get("account"), "account", 256), windowSec) };
    })),
    route("POST", "/api/accounts", handled(async (req, _p, _q, body) => {
      const action = parseAction(await object(body));
      if (action.action === "use" || action.action === "follow") {
        const tree = poolTree(app, action.id);
        await treeWrite(tree, () => runAccountAction({ ...action, id: tree }));
        app.log(actionLine(action, tree, req));
        return accountsView(tree, null, false);
      }
      const notice = await runAccountAction(action);
      app.log(actionLine(action, null, req));
      return { ...await accountsView(null, null, false), ...(notice ? { notice } : {}) };
    })),
    route("POST", "/api/accounts/priority", handled(async (req, _p, _q, body) => {
      const input = await object(body);
      const thread = text(input.thread, "thread", 256);
      if (!(POOL_PRIORITIES as readonly unknown[]).includes(input.priority)) throw new PoolError(400, "priority must be high, normal or low.");
      const tree = poolTree(app, thread);
      await treeWrite(tree, () => setPoolPriority(tree, input.priority as PoolPriority));
      app.log(`accounts: priority ${String(input.priority)} on ${thread} (${tree}) ${caller(req)}`);
      return accountsView(tree, null, false);
    })),
    route("GET", "/api/accounts/no-model-room", handled(async () => readNoModelRoom())),
    route("POST", "/api/accounts/no-model-room", handled(async (req, _p, _q, body) => {
      const value = (await object(body)).value;
      if (!NO_MODEL_ROOM.some(choice => choice === value)) throw new PoolError(400, "value must be wait, switch or fail.");
      const setting = await setNoModelRoom(value as NoModelRoom);
      app.log(`accounts: no_model_room ${setting.value} ${caller(req)}`);
      return setting;
    })),
    route("GET", "/api/accounts/login", async () => logins.current()),
    route("POST", "/api/accounts/login", handled(async (req, _p, _q, body) => {
      const input = await object(body);
      const login = logins.start(text(input.provider, "provider", 64), optional(input.account, "account", 256));
      app.log(`accounts: login${login.account ? ` ${login.account}` : ""} (${login.provider}) ${caller(req)}`);
      return login;
    })),
    route("POST", "/api/accounts/login/paste", handled(async (_r, _p, _q, body) => {
      const input = await object(body);
      return logins.paste(text(input.id, "id", 64), text(input.code, "code", 4096));
    })),
    route("POST", "/api/accounts/login/cancel", handled(async (_r, _p, _q, body) => logins.cancel(text((await object(body)).id, "id", 64)))),
    route("GET", "/api/accounts/refresh", async () => refreshes.current()),
    route("POST", "/api/accounts/refresh", handled(async (req, _p, _q, body) => {
      const input = await object(body);
      const run = refreshes.start(text(input.provider, "provider", 64), optional(input.account, "account", 256));
      app.log(`accounts: refresh${run.account ? ` ${run.account}` : ""} (${run.provider}) ${caller(req)}`);
      return run;
    })),
    ...(app.config.fixture ? [
      route("GET", "/api/fixture/pi-pool", async () => fakePoolState()),
      route("POST", "/api/fixture/pi-pool/reset", handled(async (_r, _p, query) => {
        const part = query.get("part") ?? "all";
        if (part !== "accounts" && part !== "config" && part !== "all") throw new PoolError(400, "part must be accounts, config or all.");
        reseedFakePool(part);
        if (part === "config") return fakePoolState();
        names.clear();
        forgetAccountReadings();
        return fakePoolState();
      })),
    ] : []),
  ];
}

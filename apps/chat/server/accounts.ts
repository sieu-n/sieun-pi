/**
 * The Accounts tab's endpoints (apps/chat/API.md, "Accounts"). Every pi-pool call runs through the old chat's own code in
 * legacy/prime/user-history/src/chat-pool.ts, so the pool's parsers, its shared reader and its login and refresh runners live in one place.
 * A thread is any sw factory id: a conversation id, an agent id `ag_<slug>` or a DM room `dm_<slug>`. pi-pool knows it as the tree of its
 * root thread, `pi-durable:<root thread id>` (packages/pi-host/src/main.ts).
 */
import type { IncomingMessage } from "node:http";
import {
  AccountLogins, forgetAccountReadings, listAccounts, PoolError, runAccountAction, setPoolPriority, UsageRefreshes,
} from "../../../legacy/prime/user-history/src/chat-pool.ts";
import { POOL_PRIORITIES, type AccountAction, type AccountsView, type PoolPriority } from "../web/src/lib/api/shared/types.ts";
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

/** The pool tree of a sw factory thread id. An agent or DM reads as the agent's work thread, any conversation as its root thread. */
export function poolTree(app: App, id: string): string {
  const root = parseConversationId(app.threads.conversationOf(id)).thread;
  if (!app.threads.thread(root)) throw new PoolError(404, `No thread ${id}.`);
  return `pi-durable:${root}`;
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
 * The view of a tree, or of no tree. A tree with no record yet reads as the pool with no thread, with a sentence that says why, since pi-pool
 * answers every read of it with an error.
 */
async function accountsView(tree: string | null, model: string | null, fresh: boolean): Promise<AccountsView> {
  const view = await listAccounts(tree, model, { fresh });
  if (!tree || !hasNoRecord(view)) return view;
  const pool = await listAccounts(null, model, { fresh });
  return {
    ...pool, sessionId: tree, priority: null,
    providers: pool.providers.map(entry => ({ ...entry, wait: null, resolution: entry.resolution && { ...entry.resolution, error: NO_RECORD_VIEW } })),
  };
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
  return [
    route("GET", "/api/pool", handled(async () => listAccounts(null))),
    route("GET", "/api/accounts", handled(async (_r, _p, q) => {
      const thread = q.get("thread");
      return accountsView(thread ? poolTree(app, thread) : null, optional(q.get("model") || null, "model", 256), q.get("fresh") === "1");
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
      route("POST", "/api/fixture/pi-pool/reset", async () => {
        reseedFakePool();
        forgetAccountReadings();
        return fakePoolState();
      }),
    ] : []),
  ];
}

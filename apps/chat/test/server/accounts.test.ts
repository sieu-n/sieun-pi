/**
 * The Accounts endpoints (server/accounts.ts) on the fixture's fake pi-pool (server/fixture/fake-pi-pool.mjs): every route, and every
 * account action against the fake's state.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountLogin, AccountsView, UsageRefresh } from "../../web/src/lib/api/shared/types.ts";
import { actionLine } from "../../server/accounts.ts";
import { FIXTURE_IDS } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

process.env.FAKE_PI_POOL_STEP_MS = "20";
process.env.FAKE_PI_POOL_CODEX_LOGIN_MS = "200";

let s: Running;
before(async () => { s = await start(); });
after(async () => { await s.close(); });
beforeEach(async () => { await s.send("POST", "/api/fixture/pi-pool/reset"); });

const tree = (id: string) => `pi-durable:${id}`;
const provider = (view: AccountsView, id: "anthropic" | "openai-codex") => view.providers.find(entry => entry.provider === id)!;
const row = (view: AccountsView, id: string) => view.providers.flatMap(entry => entry.rows).find(entry => entry.id === id);
const act = (body: Record<string, unknown>) => s.send<AccountsView & { error?: string }>("POST", "/api/accounts", body);

test("GET /api/pool lists every seeded account with its state", async () => {
  const view = await s.get<AccountsView>("/api/pool");
  assert.equal(view.sessionId, null);
  assert.deepEqual(provider(view, "anthropic").rows.map(entry => entry.id).sort(), [
    "claude-cooldown", "claude-depleted", "claude-limited", "claude-off", "claude-pending", "claude-pinned", "claude-ready", "claude-reauth",
    "claude-refused", "claude-resets", "claude-stale", "claude-terms",
  ]);
  assert.deepEqual(provider(view, "openai-codex").rows.map(entry => entry.id), ["codex-ready", "codex-off"]);
  assert.equal(row(view, "claude-pinned")!.pinned, true);
  assert.equal(row(view, "claude-off")!.disabled, true);
  assert.equal(row(view, "claude-reauth")!.reason, "needs-reauth");
  assert.equal(row(view, "claude-terms")!.cooldownReason, "needs terms");
  assert.equal(row(view, "claude-refused")!.cooldownReason, "oauth not allowed for organization");
  assert.ok(row(view, "claude-limited")!.limitedUntil! > Date.now());
  assert.ok(row(view, "claude-stale")!.usageAt! < Date.now() - 3 * 86_400_000);
  assert.equal(row(view, "claude-resets")!.resets!.grants[0]!.resetsLeft, 2);
  assert.equal(row(view, "claude-pending")!.resets!.pending!.grantId, "grant-b");
  assert.equal(row(view, "claude-ready")!.windows.map(window => window.label).join(","), "5h,week,Fable");
  assert.equal(view.poolConfig!.active_session_sec, 3600);
});

test("GET /api/accounts reads an agent, its DM and a conversation as the root thread's tree", async () => {
  const none = await s.get<AccountsView>("/api/accounts");
  assert.equal(none.sessionId, null);
  assert.equal(provider(none, "openai-codex").resolution!.account, "codex-ready", "with no thread it names the next request's account");
  for (const id of ["ag_vent", "dm_vent", FIXTURE_IDS.vent, `${FIXTURE_IDS.vent}:2`]) {
    const view = await s.get<AccountsView>(`/api/accounts?thread=${encodeURIComponent(id)}&model=claude-opus-5-5`);
    assert.equal(view.sessionId, tree(FIXTURE_IDS.vent), id);
    assert.equal(view.priority, "normal");
  }
  const harness = await s.get<AccountsView>(`/api/accounts?thread=${FIXTURE_IDS.harness}&fresh=1`);
  assert.equal(harness.priority, "high");
  assert.deepEqual(provider(harness, "anthropic").resolution!.selection, { mode: "manual", account_id: "claude-stale" });
  const crawler = await s.get<AccountsView>("/api/accounts?thread=ag_crawler-vp");
  assert.equal(crawler.priority, "low");
  assert.equal(provider(crawler, "anthropic").wait!.account, "claude-limited");
  assert.ok(provider(crawler, "anthropic").wait!.slotAt > Date.now());
});

test("a thread that never sent a request reads as the pool with a sentence, and a pick on it says why it cannot hold", async () => {
  const view = await s.get<AccountsView>(`/api/accounts?thread=${FIXTURE_IDS.solo}`);
  assert.equal(view.sessionId, tree(FIXTURE_IDS.solo));
  assert.equal(view.priority, null);
  assert.ok(provider(view, "anthropic").rows.length > 0);
  assert.match(provider(view, "anthropic").resolution!.error!, /sent no request yet/);
  const use = await act({ action: "use", provider: "openai-codex", account: "codex-ready", id: FIXTURE_IDS.solo });
  assert.equal(use.status, 409);
  assert.match(use.body.error!, /Send it a message first/);
  const priority = await s.send<{ error: string }>("POST", "/api/accounts/priority", { thread: FIXTURE_IDS.solo, priority: "high" });
  assert.equal(priority.status, 409);
});

test("an unknown thread is 404 and a bad action or provider is 400", async () => {
  assert.equal((await s.send("GET", "/api/accounts?thread=ag_nobody")).status, 404);
  assert.equal((await s.send("GET", "/api/accounts?thread=no-such-thread")).status, 404);
  assert.equal((await act({ action: "explode", provider: "anthropic" })).status, 400);
  const bad = await act({ action: "pin", provider: "gemini", account: "x" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error!, /pooled provider/);
  const missing = await act({ action: "pin", provider: "anthropic", account: "nobody" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error!, /pi-pool failed/);
});

test("use keeps an account for the thread and follow gives it back to Auto", async () => {
  const used = await act({ action: "use", provider: "openai-codex", account: "codex-ready", id: "dm_frontend-bro" });
  assert.equal(used.status, 200);
  assert.equal(used.body.sessionId, tree(FIXTURE_IDS.frontend));
  assert.deepEqual(provider(used.body, "openai-codex").resolution!.selection, { mode: "manual", account_id: "codex-ready" });
  const state = await s.get<{ trees: Record<string, { pins: Record<string, string> }> }>("/api/fixture/pi-pool");
  assert.equal(state.trees[tree(FIXTURE_IDS.frontend)]!.pins["openai-codex"], "codex-ready");
  const followed = await act({ action: "follow", provider: "openai-codex", id: "ag_frontend-bro" });
  assert.deepEqual(provider(followed.body, "openai-codex").resolution!.selection, { mode: "auto" });
});

test("pin and unpin set and clear the pool pin", async () => {
  const pinned = await act({ action: "pin", provider: "anthropic", account: "claude-ready" });
  assert.equal(row(pinned.body, "claude-ready")!.pinned, true);
  assert.equal(row(pinned.body, "claude-pinned")!.pinned, false);
  const unpinned = await act({ action: "unpin", provider: "anthropic" });
  assert.ok(!provider(unpinned.body, "anthropic").rows.some(entry => entry.pinned));
});

test("off, on and remove change the account", async () => {
  assert.equal(row((await act({ action: "disable", provider: "anthropic", account: "claude-ready" })).body, "claude-ready")!.disabled, true);
  assert.equal(row((await act({ action: "enable", provider: "anthropic", account: "claude-ready" })).body, "claude-ready")!.disabled, false);
  assert.equal(row((await act({ action: "remove", provider: "openai-codex", account: "codex-off" })).body, "codex-off"), undefined);
});

test("resets, reset, a retried claim and check again answer with a notice", async () => {
  const all = await act({ action: "resets", provider: "anthropic" });
  assert.equal(all.body.notice, "Resets read for 10 of 11 accounts. claude-reauth@example.test: the account needs a new sign-in.");
  const one = await act({ action: "resets", provider: "anthropic", account: "claude-ready" });
  assert.equal(one.body.notice, "Resets read for claude-ready@example.test.");
  const spent = await act({ action: "reset", provider: "anthropic", account: "claude-resets", grant: "grant-a" });
  assert.equal(spent.body.notice, "Reset spent on claude-resets@example.test. 1 left.");
  assert.equal(row(spent.body, "claude-resets")!.reason, null);
  const retried = await act({ action: "reset", provider: "anthropic", account: "claude-pending", grant: "grant-b" });
  assert.match(retried.body.notice!, /earlier claim went through/);
  assert.equal(row(retried.body, "claude-pending")!.resets!.pending, null);
  const none = await act({ action: "reset", provider: "anthropic", account: "claude-ready" });
  assert.equal(none.body.notice, "claude-ready@example.test has no reset to spend.");
  const codex = await act({ action: "reset", provider: "openai-codex", account: "codex-ready" });
  assert.equal(codex.status, 400);
  const recheck = await act({ action: "recheck", provider: "anthropic" });
  assert.match(recheck.body.notice!, /claude-terms@example.test still refused: needs terms\. .*claude-cooldown@example.test answers again\.$/);
  assert.equal(row(recheck.body, "claude-cooldown")!.reason, null);
});

test("priority moves the thread's class", async () => {
  const moved = await s.send<AccountsView>("POST", "/api/accounts/priority", { thread: "ag_vent", priority: "low" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.priority, "low");
  assert.equal(moved.body.sessionId, tree(FIXTURE_IDS.vent));
  assert.equal((await s.send("POST", "/api/accounts/priority", { thread: "ag_vent", priority: "urgent" })).status, 400);
});

const login = () => s.get<AccountLogin | null>("/api/accounts/login");

test("a Claude sign-in asks for a paste, takes a retry, and adds the account", async () => {
  const started = await s.send<AccountLogin>("POST", "/api/accounts/login", { provider: "anthropic", account: null });
  assert.equal(started.status, 200);
  const waiting = await until(login, value => value?.status === "waiting");
  assert.equal(waiting!.paste, true);
  assert.match(waiting!.url!, /^https:\/\/claude\.ai\//);
  assert.equal((await s.send("POST", "/api/accounts/login", { provider: "anthropic", account: null })).status, 409, "one sign-in at a time");
  await s.send("POST", "/api/accounts/login/paste", { id: started.body.id, code: "retry-me" });
  await until(login, value => value?.status === "waiting" && value.message !== null);
  const pasted = await s.send<AccountLogin>("POST", "/api/accounts/login/paste", { id: started.body.id, code: "code#state" });
  assert.equal(pasted.body.status, "finishing");
  const done = await until(login, value => value?.status === "done");
  assert.equal(done!.message, "Added claude-new-1@example.test.");
  assert.ok(row(await s.get<AccountsView>("/api/pool"), "claude-new-1"));
});

test("a sign-in again for an expired account clears its needs-login, and cancel ends a sign-in", async () => {
  const again = await s.send<AccountLogin>("POST", "/api/accounts/login", { provider: "anthropic", account: "claude-reauth" });
  await until(login, value => value?.status === "waiting");
  await s.send("POST", "/api/accounts/login/paste", { id: again.body.id, code: "code" });
  await until(login, value => value?.status === "done");
  assert.equal(row(await s.get<AccountsView>("/api/pool"), "claude-reauth")!.reason, null);
  const cancelled = await s.send<AccountLogin>("POST", "/api/accounts/login", { provider: "anthropic", account: null });
  await until(login, value => value?.status === "waiting");
  await s.send("POST", "/api/accounts/login/cancel", { id: cancelled.body.id });
  await until(login, value => value?.status === "cancelled");
  assert.equal((await s.send("POST", "/api/accounts/login/paste", { id: cancelled.body.id, code: "x" })).status, 404);
});

test("a Codex sign-in shows its device code and finishes by itself", async () => {
  await s.send("POST", "/api/accounts/login", { provider: "openai-codex", account: null });
  const waiting = await until(login, value => value?.status === "waiting");
  assert.equal(waiting!.code, "ABCD-1234");
  assert.equal(waiting!.paste, false);
  await until(login, value => value?.status === "done");
  assert.ok(row(await s.get<AccountsView>("/api/pool"), "codex-new-1"));
});

test("a usage refresh reads the accounts one by one and names the one it could not read", async () => {
  const refreshes = () => s.get<UsageRefresh[]>("/api/accounts/refresh");
  const started = await s.send<UsageRefresh>("POST", "/api/accounts/refresh", { provider: "anthropic", account: null });
  assert.equal(started.body.status, "running");
  assert.equal((await s.send("POST", "/api/accounts/refresh", { provider: "anthropic", account: null })).status, 409);
  const seen = await until(refreshes, runs => runs.some(run => run.accounts.some(entry => entry.state === "reading")));
  assert.ok(seen.find(run => run.provider === "anthropic")!.accounts.some(entry => entry.state === "queued"));
  const done = (await until(refreshes, runs => runs.find(run => run.provider === "anthropic")?.status === "done")).find(run => run.provider === "anthropic")!;
  assert.equal(done.accounts.length, 12);
  assert.deepEqual(done.accounts.filter(entry => entry.state === "failed").map(entry => entry.id), ["claude-reauth"]);
  assert.equal(done.accounts.filter(entry => entry.state === "read").length, 11);
  await s.send("POST", "/api/accounts/refresh", { provider: "openai-codex", account: "codex-ready" });
  const one = (await until(refreshes, runs => runs.find(run => run.provider === "openai-codex")?.status === "done")).find(run => run.provider === "openai-codex")!;
  assert.deepEqual(one.accounts.map(entry => [entry.id, entry.state]), [["codex-ready", "read"]]);
});

test("the fixture's reset puts the seed state back", async () => {
  await act({ action: "remove", provider: "anthropic", account: "claude-ready" });
  const state = await s.send<{ accounts: { id: string }[] }>("POST", "/api/fixture/pi-pool/reset");
  assert.ok(state.body.accounts.some(entry => entry.id === "claude-ready"));
  assert.ok(row(await s.get<AccountsView>("/api/pool"), "claude-ready"));
});

test("the log line names the action, the account, the thread and the caller", () => {
  const req = { headers: { "user-agent": "Mozilla/5.0" }, socket: { remoteAddress: "127.0.0.1" } } as never;
  assert.equal(actionLine({ action: "use", provider: "anthropic", account: "claude-ready", id: "ag_vent" }, "pi-durable:abc", req),
    "accounts: use claude-ready (anthropic) on ag_vent (pi-durable:abc) from 127.0.0.1 (Mozilla/5.0)");
});

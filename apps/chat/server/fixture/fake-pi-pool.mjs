#!/usr/bin/env node
/**
 * A fake pi-pool for apps/chat's --fixture (server/fixture/pool.ts). It answers every command server/accounts.ts runs through the old
 * chat's chat-pool.ts, with the JSON shapes the installed pi-pool prints, and keeps its state in `$PI_POOL_DIR/fake-pi-pool.json`.
 * `fake-seed` writes the seed state again. The seed names each account by its state, so a spec can find the row it needs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.PI_POOL_DIR;
if (!dir) {
  process.stderr.write("fake pi-pool: set PI_POOL_DIR\n");
  process.exit(2);
}
const file = join(dir, "fake-pi-pool.json");
/** How long each refresh read and the Codex sign-in take, so a page can see them run. */
const STEP_MS = Number(process.env.FAKE_PI_POOL_STEP_MS ?? 300);
const CODEX_LOGIN_MS = Number(process.env.FAKE_PI_POOL_CODEX_LOGIN_MS ?? 3000);
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

const CONFIG = {
  refresh_skew_sec: 900, admit_5h_max_pct: 100, low_admit_5h_max_pct: 50, seven_day_max_pct: 98, admit_slot_sec: 120, cooldown_sec: 1200,
  active_session_sec: 3600, refused_cooldown_sec: 86400, agent_queue_on: 1, working_max: 40, tree_working_max: 60,
  tier_units: { "max 20x": 4, "max 5x": 1 }, switch_models: ["fable"],
};

function seed(now = Date.now() / 1000) {
  const account = (provider, id, extra = {}) => ({
    provider, id, email: `${id}@example.test`, tier: provider === "anthropic" ? "max 20x" : "pro", disabled: false, reason: null,
    cooldown_reason: null, cooldown_until: null, limited_until: null, session_pct: 20, weekly_pct: 30, model_pct: 10, usage_at: now - 2 * MIN,
    sessions: 0, resets: provider === "anthropic" ? noGrant(now) : undefined, ...extra,
  });
  const grant = (id, left, extra = {}) => ({
    id, label: "Max plan resets", resets_total: 3, resets_left: left, starts_at: new Date((now - 10 * DAY) * 1000).toISOString(),
    ends_at: new Date((now + 20 * DAY) * 1000).toISOString(), clears: ["five_hour", "seven_day"], paused: false, usable_now: true, use_requires_limit: true, ...extra,
  });
  const accounts = [
    account("anthropic", "claude-ready", { session_pct: 42, weekly_pct: 61, sessions: 3 }),
    account("anthropic", "claude-pinned", { session_pct: 12, weekly_pct: 25, sessions: 1 }),
    account("anthropic", "claude-off", { disabled: true, session_pct: 0, weekly_pct: 0 }),
    account("anthropic", "claude-reauth", { reason: "needs-reauth", resets: { error: "the account needs a new sign-in", error_at: now - HOUR } }),
    account("anthropic", "claude-terms", { reason: "cooldown 23h", cooldown_reason: "needs terms", cooldown_until: now + 23 * HOUR }),
    account("anthropic", "claude-refused", { reason: "cooldown 20h", cooldown_reason: "oauth not allowed for organization", cooldown_until: now + 20 * HOUR }),
    account("anthropic", "claude-cooldown", { reason: "cooldown 15m", cooldown_until: now + 15 * MIN }),
    account("anthropic", "claude-limited", { reason: "limited 2h", limited_until: now + 2 * HOUR, session_pct: 71, weekly_pct: 74, sessions: 2 }),
    account("anthropic", "claude-depleted", { reason: "depleted", session_pct: 100, weekly_pct: 99, model_pct: 92, sessions: 1 }),
    account("anthropic", "claude-stale", { session_pct: 8, weekly_pct: 40, usage_at: now - 4 * DAY }),
    account("anthropic", "claude-resets", {
      reason: "depleted", session_pct: 100, weekly_pct: 100,
      resets: { checked_at: now - 30 * MIN, status: { eligible: true, ineligible_reason: null, at_limit: true, grants: [grant("grant-a", 2)], next_grant_id: "grant-a", cooldown_until: null } },
    }),
    account("anthropic", "claude-pending", {
      reason: "depleted", session_pct: 100, weekly_pct: 96,
      resets: {
        checked_at: now - 20 * MIN, status: { eligible: true, ineligible_reason: null, at_limit: true, grants: [grant("grant-b", 1)], next_grant_id: "grant-b", cooldown_until: null },
        pending: { grant_id: "grant-b", created_at: now - 2 * MIN },
      },
    }),
    account("openai-codex", "codex-ready", { session_pct: 5, weekly_pct: 87, sessions: 2 }),
    account("openai-codex", "codex-off", { disabled: true }),
  ];
  const trees = {};
  for (const [tree, record] of Object.entries(JSON.parse(process.env.FAKE_PI_POOL_TREES || "{}"))) {
    const wait = record.wait ? { [record.wait.provider]: { account: record.wait.account, slot_at: now + record.wait.inSec } } : {};
    trees[tree] = { priority: record.priority ?? "normal", pins: record.pins ?? {}, current: {}, wait };
  }
  return { providers: { anthropic: { pin: "claude-pinned" }, "openai-codex": { pin: null } }, accounts, trees, added: 0 };
}

function noGrant(now) {
  return { checked_at: now - HOUR, status: { eligible: false, ineligible_reason: "no_grant", at_limit: false, grants: [], next_grant_id: null, cooldown_until: null } };
}

function load() {
  if (!existsSync(file)) save(seed());
  return JSON.parse(readFileSync(file, "utf8"));
}

function save(state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
  renameSync(file + ".tmp", file);
}

function flags(args) {
  const out = { provider: "anthropic", session: undefined, model: null, json: false, follow: false, newSession: false, stream: false, force: false, grant: null, threads: [], trees: [], positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") out.provider = args[++i];
    else if (arg === "--session") out.session = args[++i];
    else if (arg === "--model") out.model = args[++i] || null;
    else if (arg === "--grant") out.grant = args[++i];
    else if (arg === "--timeout") out.timeout = Number(args[++i]);
    else if (arg === "--thread") out.threads.push({ session: args[++i] || null, model: args[++i] || null });
    else if (arg === "--tree") out.trees.push(args[++i]);
    else if (arg === "--by") i++;
    else if (arg === "--json") out.json = true;
    else if (arg === "--follow") out.follow = true;
    else if (arg === "--new-session") out.newSession = true;
    else if (arg === "--stream") out.stream = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--off" || arg === "--label") continue;
    else out.positional.push(arg);
  }
  return out;
}

class Exit extends Error {
  constructor(code, out) { super(out); this.code = code; this.out = out; }
}
const unknownSession = session => new Exit(2, `--session ${session} matches no known session\n`);
const json = value => JSON.stringify(value, null, 2) + "\n";

const reasonOf = account => (account.disabled ? "disabled" : account.reason);
const usable = account => reasonOf(account) === null;
const find = (state, provider, id) => state.accounts.find(account => account.provider === provider && (account.id === id || account.email === id));

function treeOf(state, session) {
  if (session === null) return null;
  const tree = state.trees[session];
  if (!tree) throw unknownSession(session);
  return tree;
}

/** The account a tree resolves to: its own pick, the pool pin, the account it has, else the emptiest usable one. */
function resolve(state, provider, tree) {
  const pin = tree?.pins?.[provider] ?? null;
  const poolPin = state.providers[provider].pin;
  const manual = pin ?? poolPin;
  if (manual) return { account: find(state, provider, manual) ?? null, reason: pin ? "session_pin" : "pool_pin", manual };
  const current = tree?.current?.[provider] ? find(state, provider, tree.current[provider]) : null;
  if (current && usable(current)) return { account: current, reason: "stay", manual: null };
  const best = state.accounts.filter(account => account.provider === provider && usable(account)).sort((a, b) => a.session_pct - b.session_pct)[0];
  return { account: best ?? null, reason: best ? "new" : null, manual: null };
}

const windows = account => [
  { kind: "session", label: "5h", name: null, pct: account.session_pct, window_sec: 5 * HOUR, resets_at: account.usage_at + 3 * HOUR, sampled_at: account.usage_at },
  { kind: "weekly", label: "week", name: null, pct: account.weekly_pct, window_sec: 7 * DAY, resets_at: account.usage_at + 4 * DAY, sampled_at: account.usage_at },
  ...(account.provider === "anthropic" ? [{ kind: "model", label: "Fable", name: "Fable", pct: account.model_pct, window_sec: 7 * DAY, resets_at: account.usage_at + 4 * DAY, sampled_at: account.usage_at }] : []),
];

function ls(state, f) {
  const provider = f.provider;
  const tree = treeOf(state, f.session ?? null);
  const picked = resolve(state, provider, tree);
  const poolPin = state.providers[provider].pin;
  const rows = state.accounts.filter(account => account.provider === provider).map(account => {
    const reason = reasonOf(account);
    return {
      id: account.id, email: account.email, label: account.email, usage: `${Math.round(account.session_pct)}%/${Math.round(account.weekly_pct)}%`,
      session_pct: account.session_pct, weekly_pct: account.weekly_pct, gated_pct: 0, usable: reason === null, serves: reason === null, reason,
      current: picked.account?.id === account.id, pinned: poolPin === account.id, disabled: account.disabled, score: reason === null ? 100 - account.session_pct : null,
      slot_cap: 1, tier: account.tier, windows: windows(account), usage_at: account.usage_at, sessions: account.sessions, cooldown_until: account.cooldown_until,
      cooldown_reason: account.cooldown_reason, limited_until: account.limited_until, ...(account.resets ? { resets: account.resets } : {}),
    };
  });
  return {
    provider, session: f.session ?? null, pin: poolPin ? { id: poolPin } : null, priority: tree?.priority ?? "normal",
    selection: picked.manual ? { mode: "manual", account_id: picked.manual } : { mode: "auto" }, wait: tree?.wait?.[provider] ?? null, rows,
  };
}

function who(state, f) {
  const tree = treeOf(state, f.session ?? null);
  const providers = {};
  for (const provider of ["anthropic", "openai-codex"]) {
    const picked = resolve(state, provider, tree);
    const account = picked.account;
    providers[provider] = {
      account: account?.id ?? null, email: account?.email ?? null, label: account?.email ?? null, reason: picked.reason, pinned: picked.manual !== null,
      selection: picked.manual ? { mode: "manual", account_id: picked.manual } : { mode: "auto" }, shadowed: null, at: null, wait: tree?.wait?.[provider] ?? null,
      moves_today: 0, ...(picked.manual && !account ? { error: `${picked.manual} is no longer in the pool` } : {}),
    };
  }
  return { session: f.session ?? null, priority: tree?.priority ?? "normal", providers };
}

const queue = () => ({ enabled: true, working_max: 40, working_max_set: null, tree_working_max: 60, working: [], queued: [] });

/** One command as {code, out, err}, the way `pi-pool snapshot` reports each of its parts. */
function part(run) {
  try { return { code: 0, out: run(), err: "" }; }
  catch (error) {
    if (error instanceof Exit) return { code: error.code, out: json({ error: error.out.trim() }), err: "" };
    throw error;
  }
}

function snapshot(state, f) {
  if (f.trees.length) {
    return { trees: f.trees.map(session => ({ session, priority: state.trees[session]?.priority ?? null, label: null })) };
  }
  return {
    queue: part(() => json(queue())), config: part(() => json(CONFIG)),
    threads: f.threads.map(thread => {
      const g = { ...f, session: thread.session ?? undefined, model: thread.model };
      return {
        session: thread.session, model: thread.model, who: part(() => json(who(state, g))),
        ls: Object.fromEntries(["anthropic", "openai-codex"].map(provider => [provider, part(() => json(ls(state, { ...g, provider })))])),
      };
    }),
  };
}

function needAccount(state, f) {
  const account = find(state, f.provider, f.positional[0]);
  if (!account) throw new Exit(2, `${f.positional[0] ?? "(none)"} is not in the ${f.provider} pool\n`);
  return account;
}

function use(state, f) {
  const tree = state.trees[f.session];
  if (!tree) throw unknownSession(f.session);
  if (f.follow) {
    if (!tree.pins[f.provider]) return "already following the pool\n";
    delete tree.pins[f.provider];
    return `following the pool (${f.provider})\n`;
  }
  const account = needAccount(state, f);
  tree.pins[f.provider] = account.id;
  tree.current[f.provider] = account.id;
  delete tree.wait[f.provider];
  return `${account.email} selected for this session tree in Manual mode; requests stay pinned until you select Auto (pi-pool use --follow)\n`;
}

function resets(state, f) {
  const now = Date.now() / 1000;
  const chosen = f.positional.length ? [needAccount(state, { ...f, provider: "anthropic" })] : state.accounts.filter(account => account.provider === "anthropic" && !account.disabled);
  return {
    accounts: chosen.map(account => {
      if (account.reason === "needs-reauth") {
        account.resets = { error: "the account needs a new sign-in", error_at: now };
        return { id: account.id, email: account.email, label: account.email, error: "the account needs a new sign-in" };
      }
      account.resets = { ...(account.resets?.status ? account.resets : noGrant(now)), checked_at: now };
      return { id: account.id, email: account.email, label: account.email };
    }),
  };
}

function reset(state, f) {
  const account = needAccount(state, { ...f, provider: "anthropic" });
  const status = account.resets?.status;
  const pending = account.resets?.pending ?? null;
  const id = f.grant ?? status?.next_grant_id;
  const grant = status?.grants.find(entry => entry.id === id);
  if (!grant || grant.resets_left < 1) throw new Exit(1, json({ ok: false, message: `${account.email} has no reset to spend.` }));
  grant.resets_left -= 1;
  delete account.resets.pending;
  status.at_limit = false;
  account.session_pct = 0;
  account.weekly_pct = 0;
  account.reason = null;
  const left = `${grant.resets_left} left`;
  return { ok: true, message: pending ? `The earlier claim went through on ${account.email}. ${left}.` : `Reset spent on ${account.email}. ${left}.` };
}

function probe(state) {
  const lines = [];
  for (const account of state.accounts) {
    if (account.disabled || !account.reason?.startsWith("cooldown")) continue;
    if (!account.cooldown_reason) {
      account.reason = null;
      account.cooldown_until = null;
      lines.push(`${account.email} answers again`);
    } else lines.push(`${account.email} still refused: ${account.cooldown_reason}`);
  }
  return lines.join("; ") + "\n";
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function refresh(f) {
  const say = event => process.stdout.write(JSON.stringify(event) + "\n");
  const first = load();
  const chosen = f.positional.length
    ? f.positional.map(id => find(first, f.provider, id)).filter(Boolean)
    : first.accounts.filter(account => account.provider === f.provider);
  if (f.positional.length && !chosen.length) { say({ event: "error", message: `${f.positional[0]} is not in the ${f.provider} pool` }); return 1; }
  say({ event: "accounts", accounts: chosen.map(account => ({ id: account.id, email: account.email, label: account.email })) });
  for (const { id } of chosen) {
    say({ event: "reading", id });
    await sleep(STEP_MS);
    const state = load();
    const account = find(state, f.provider, id);
    if (!account || account.reason === "needs-reauth") {
      say({ event: "read", id, ok: false, reason: "the account needs a new sign-in", usage_at: account?.usage_at ?? null, retry_at: null });
      continue;
    }
    account.usage_at = Date.now() / 1000;
    save(state);
    say({ event: "read", id, ok: true, reason: null, usage_at: account.usage_at, retry_at: null });
  }
  say({ event: "end" });
  return 0;
}

/** Claude asks for a pasted callback URL or code; a line with "retry" in it is refused once more, any other line signs in. Codex shows a device code and signs in by itself. */
async function login(f) {
  const say = event => process.stdout.write(JSON.stringify(event) + "\n");
  const claude = f.provider === "anthropic";
  const finish = () => {
    const state = load();
    const named = f.positional[0] ? find(state, f.provider, f.positional[0]) : null;
    if (named) {
      if (named.reason === "needs-reauth") named.reason = null;
      named.resets = claude ? noGrant(Date.now() / 1000) : undefined;
      save(state);
      return `Signed in ${named.email} again.`;
    }
    state.added += 1;
    const id = `${claude ? "claude" : "codex"}-new-${state.added}`;
    state.accounts.push({
      provider: f.provider, id, email: `${id}@example.test`, tier: claude ? "max 5x" : "pro", disabled: false, reason: null, cooldown_reason: null,
      cooldown_until: null, limited_until: null, session_pct: 0, weekly_pct: 0, model_pct: 0, usage_at: Date.now() / 1000, sessions: 0,
      ...(claude ? { resets: noGrant(Date.now() / 1000) } : {}),
    });
    save(state);
    return `Added ${id}@example.test.`;
  };
  if (claude) say({ event: "url", url: "https://claude.ai/oauth/authorize?fixture=1", manual_url: "https://console.anthropic.com/oauth/code/callback?fixture=1", code: null, paste: true });
  else say({ event: "url", url: "https://auth.openai.com/codex/device", manual_url: null, code: "ABCD-1234", paste: false });
  const deadline = setTimeout(() => { say({ event: "done", ok: false, message: "The sign-in timed out." }); process.exit(1); }, (f.timeout ?? 600) * 1000);
  const lines = createInterface({ input: process.stdin });
  if (!claude) {
    const done = setTimeout(() => { say({ event: "done", ok: true, message: finish() }); process.exit(0); }, CODEX_LOGIN_MS);
    lines.on("close", () => { clearTimeout(done); clearTimeout(deadline); process.exit(1); });
    return;
  }
  lines.on("line", line => {
    if (!line.trim()) return;
    if (line.includes("retry")) { say({ event: "retry", message: "That code was not accepted. Paste the matching callback URL or code and try again." }); return; }
    clearTimeout(deadline);
    say({ event: "done", ok: true, message: finish() });
    process.exit(0);
  });
  lines.on("close", () => { clearTimeout(deadline); process.exit(1); });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const f = flags(rest);
  if (command === "fake-seed") { save(seed()); return 0; }
  if (command === "refresh") return refresh(f);
  if (command === "login") { await login(f); return null; }
  const state = load();
  const write = (out, changed = true) => { if (changed) save(state); process.stdout.write(out); return 0; };
  switch (command) {
    case "snapshot": return write(json(snapshot(state, f)), false);
    case "ls": return write(json(ls(state, f)), false);
    case "who": return write(json(who(state, f)), false);
    case "queue": return write(json(queue()), false);
    case "config": return write(json(CONFIG), false);
    case "use": return write(use(state, f));
    case "pin": { const account = needAccount(state, f); state.providers[f.provider].pin = account.id; return write(`${account.email} pinned for all sessions\n`); }
    case "unpin": state.providers[f.provider].pin = null; return write("unpinned\n");
    case "switch": return write("switched\n", false);
    case "off": needAccount(state, f).disabled = true; return write("off\n");
    case "on": needAccount(state, f).disabled = false; return write("on\n");
    case "rm": {
      const account = needAccount(state, f);
      state.accounts = state.accounts.filter(entry => entry !== account);
      if (state.providers[f.provider].pin === account.id) state.providers[f.provider].pin = null;
      return write(`removed ${account.email}\n`);
    }
    case "resets": return write(json(resets(state, f)));
    case "reset": return write(json(reset(state, f)));
    case "probe": return write(probe(state));
    case "priority": {
      const tree = state.trees[f.session];
      if (!tree) throw unknownSession(f.session);
      tree.priority = f.positional[0];
      return write(`${f.session}: ${f.positional[0]}\n`);
    }
    default:
      process.stderr.write("usage: pi-pool [command]\n");
      return 2;
  }
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
} catch (error) {
  if (!(error instanceof Exit)) throw error;
  process.stdout.write(error.out);
  process.exitCode = error.code;
}

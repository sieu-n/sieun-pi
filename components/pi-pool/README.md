# pi-pool - account pooling for Prime Agent (pi)

Every pi session draws its Claude and Codex credentials from the accounts already
pooled in `tokenmaxxing`, instead of one fixed login. You can move one session to a
different account while it runs, with no `/login` and no restart.

## Source and runtime state

This directory is the maintained pi-pool source, verified live on Prime Agent 0.9.5.
Python uses the macOS `/usr/bin/python3` standard library. The extension uses
Prime Agent's public types and its `@earendil-works/pi-tui` dependency.
No account store or credential is included here.

```text
checkout/components/pi-pool/
  vend.py                  code root from realpath(__file__)
  app/extension/           /account command, account line, login adoption
  bin/                     executable, relocatable Python wrappers

PI_POOL_DIR or ~/.config/pi-pool/
  config.json, state.json   configuration, pins, seats and session records
  lock, pi-pool.log         lock and event log
  rotations/, fallback.json, backups/   private runtime data
```

`PI_POOL_DIR` selects state only. It never selects Python modules or executables.
The wrappers resolve symlinks before they locate source files.
Both wrappers use `-B`, so normal commands do not write Python bytecode into source.

The root installer owns these links. It retains the state directory itself and
its existing private files.

```text
~/.config/pi-pool/vend.py -> <checkout>/components/pi-pool/vend.py
~/.config/pi-pool/app     -> <checkout>/components/pi-pool/app
~/.config/pi-pool/bin     -> <checkout>/components/pi-pool/bin
~/.local/bin/pi-pool      -> <checkout>/components/pi-pool/bin/pi-pool
```

These links preserve existing `!command` paths under `~/.config/pi-pool`.
New `enable` entries point to the source wrapper and quote paths with spaces.
For a custom state directory, pass the same `PI_POOL_DIR` to the CLI and Prime Agent.
The installer must create that directory before commands that write configuration.
The CLI rejects state roots inside this source directory.

The extension link points to source. A new session loads the current extension; a
running session keeps the code it loaded until it is rebuilt.

## External credential dependencies

pi-pool depends on the user's existing tokenmaxxing pool under
`~/.config/tokenmaxxing` (or `TOKENMAXXING_HOME`). It reads the per-account
store layout that tokenmaxxing 1.44 and later use, index schema version 2.
A version 1 index makes every command fail with the schema version in the error.
This repository does not install or seed those stores.

| dependency | use |
|---|---|
| `accounts.json` (v2) | Claude account ids, emails, usage `windows` and `needsReauth` |
| `stores/<uuid8>/` | One Claude store per account. Its credential is the Keychain item `Claude Code-credentials-<sha256(store path)[:8]>`, the same item a supervised `claude` reads |
| macOS Keychain | Claude credentials, read and written through `/usr/bin/security` using `USER` as the keychain account |
| `lock` and `stores/<uuid8>/.oauth_refresh.lock` + `stores/<uuid8>.lock` | tokenmaxxing's Claude pool lock, then Claude Code's own refresh lock on that store |
| `live/` | Presence files of supervised `claude` sessions, a picker penalty only |
| `codex-accounts.json` (v2) | Codex account ids, emails, plan (`tier`), usage `windows` and `needsReauth` |
| `codex-stores/<uuid8>/auth.json` | One Codex store per account, refreshed in place |
| `codex-lock` | tokenmaxxing's Codex refresh lock |
| `codex-live/` | Presence files of supervised `codex` sessions. pi-pool never refreshes a store one of them runs on |

A dead refresh token (`invalid_grant`, `refresh_token_reused`) sets `needsReauth`
on that account in tokenmaxxing's index, so `tokenmaxxing auth --all` offers it.
On a seat move or a fresh rotation, pi-pool also sends one free
`/v1/messages/count_tokens` request. A 401 or a 403 such as
`oauth_not_allowed_for_organization` puts the account on a
`refused_cooldown_sec` cooldown (24 hours by default) and sets tokenmaxxing's own
`enforcedUntil` on the account.

Refresh requests use `https://platform.claude.com/v1/oauth/token` and
`https://auth.openai.com/oauth/token`. They require network access and valid grants.
The pool returns only access tokens to Prime. Rotation journals and legacy
`fallback.json` can contain refresh tokens, so the state directory is private too.
Neither those files nor the credential stores belong in Git.

## Switch the account for this session

In the TUI:

    /account

It lists the pool with usage and flags, plus a "Follow the pool" row. Codex rows also
carry the plan (`email  plus  0%/100%  [depleted]`); `ls --json` puts it in a `plan`
field on codex rows only. Pick a row.
The tray shows `<email> (next request)` and the switch lands on that session's next
request. Picking an account that is depleted or in cooldown asks first, then pins it
anyway.

From a shell inside the session:

    pi-pool use claude1@example.test      # pin this session tree
    pi-pool use claude1@example.test --force   # pin it even when it is depleted
    pi-pool use --follow                 # drop the pin, follow the pool again
    pi-pool who                          # what this session resolves to now
    pi-pool ls                           # the rows /account renders

`use` writes an intent, nothing else. No request is made and no credential is read
until the session's next provider request runs the hook.

## Commands

    pi-pool                       one card per account: usage bars, seat, sessions, next pick
    pi-pool status --provider openai-codex
    pi-pool watch [sec]           the same cards full screen, redrawn every sec seconds (default 5)
    pi-pool use <email|id> [--force] [--follow] [--provider p] [--session id] [--new-session]
                                  --new-session pins a session created a moment ago (full uuid) before its first request
    pi-pool who [--json] [--session id]
    pi-pool ls [--json] [--provider p] [--session id]
    pi-pool pin <email>           force EVERY session onto one account
    pi-pool unpin
    pi-pool switch                drop the seat; the next request re-picks
    pi-pool enable openai-codex   wire the codex provider into models.json
    pi-pool adopt-logins          move a stored /login that would bypass the pool into fallback.json
    pi-pool refresh [--json]      sample every account's usage now (runs `tokenmaxxing status --json`)
    pi-pool off <email|id> [--provider <p>]   keep an account pooled but never pick it (`ls --json` shows `disabled`)
    pi-pool on <email|id> [--provider <p>]    let the pool pick it again
    pi-pool rm <email|id> [--provider <p>]    `tokenmaxxing rm`, then drop its pins and seat here
    pi-pool login [<email|id>] [--provider <p>] [--timeout <sec>]
                                  add an account (`tokenmaxxing add`) or sign one in again (`tokenmaxxing auth`)
                                  for a browser: stdout is JSON lines ({"event":"url"} with the link and the
                                  Codex device code, {"event":"retry"}, one {"event":"done","ok":...}); stdin takes
                                  one pasted Claude code per line, and closing stdin cancels
    pi-pool probe [--force]       check every Claude account for an API refusal (no token refresh)
    pi-pool log [n]               last n pool events
    pi-pool config / set <k> <v>

`--session` takes a session uuid, a uuid prefix, or the short active id.

`ls --json` names the pool `pin` next to the `seat`. Its rows also carry what `status` draws: `tier` (`max 20x`, `pro`), `windows`
(one entry per usage window in display order, each with `kind` session, weekly or model,
`label`, live `pct`, `resets_at` in epoch seconds or null, `window_sec`, `sampled_at`),
`usage_at` and `usage_age_sec`, `sessions` (vends in the last hour), and `cooldown_until`
and `cooldown_reason` for a refused account.

`refresh` asks tokenmaxxing to read every account's usage now, the same read
`tokenmaxxing status` does. It writes only tokenmaxxing's usage figures. It moves no seat
or pin. tokenmaxxing may refresh an expiring Codex store under its own lock while it
reads, as its `status` always does. Claude usage is also sampled every minute by
tokenmaxxing's `check` timer; Codex usage only when tokenmaxxing samples it, so Codex
figures can be hours old.

## Which account a request gets

First match wins, per provider:

| # | source | set by | yields when |
|---|---|---|---|
| 1 | session pin | `/account`, `pi-pool use` | the account cannot serve. With `--force`, only when its credential cannot be read |
| 2 | pool pin | `pi-pool pin` | the account needs re-auth |
| 3 | codex plan upgrade | plan tiers `free < plus < pro < team` | no usable codex account sits on a higher plan than the seat |
| 4 | seat | the pool itself | the seat cannot serve |
| 5 | best candidate | score | never; no candidate is an error |

A session pin that yields writes nothing, so it re-applies by itself the moment the
window resets. `pi-pool who` names the pin it is shadowing.

Step 3 exists because the seat otherwise moves only when it cannot serve. A free codex
account taken while the paid one was depleted would hold every unpinned session after
the paid window resets, and the API refuses several models on a free plan with a 400
"not supported when using Codex with a ChatGPT account". The upgrade moves the seat
(reason `seat_upgrade`) and touches no pin. Anthropic accounts carry no plan, so the
step never fires there.

Score, lowest wins: `max(5h%, 7d%) + 8 per session that vended from it in the last
hour + 15 if a tokenmaxxing-supervised session runs on it`. Excluded: needs-reauth,
depleted (>=95% 5h or >=98% 7d or the Fable cap), and accounts in cooldown. A cooldown
comes from a refusal probe (see the dependency section) and also overrides a `--force` pin.

## A pin covers the whole session tree

The pool keys by the ROOT session uuid, taken from the daemon worker descriptor
(`daemon-workers/<daemonId>/<workerId>.json` -> `rootSessionId`). One worker process
serves one root session and every `rlm()` subagent under it, so a pin set anywhere in
a tree covers the whole tree.

The short active session id is NOT stable: resuming a session in a new worker gives it
a new one (verified 2026-09-06). It is stored for display and for `--session <short id>`
lookups, never as the key.

## openai-codex

    pi-pool enable openai-codex

writes the provider entry into `~/.prime/agent/models.json`. The entry needs `baseUrl`.
A provider entry with only `apiKey` fails `validateConfig` and takes every model down,
not just codex.

Codex credentials live in `~/.config/tokenmaxxing/codex-stores/<uuid8>/auth.json`. A
rotation takes tokenmaxxing's `codex-lock` and is journalled before the write. A store
that a supervised codex session runs on is never refreshed here: the codex CLI owns
that rotation.

## Why the pool vends access tokens, never refresh tokens

pi and Claude Code use the same OAuth client
(`9d1c250a-e61b-44d9-88ed-5944d1962f5e`), so tokenmaxxing's credentials work in pi
unchanged. But Anthropic rotates the refresh token on every refresh, so two independent
refreshers on one grant family kill each other: whoever refreshes second gets
`invalid_grant`.

So pi is never given a refresh token. The hook vends a short-lived access token, and any
rotation happens inside tokenmaxxing's own store under tokenmaxxing's own flock.

This works because pi sniffs the key string, not the credential type
(`isOAuthToken = apiKey.includes("sk-ant-oat")`), so a plain `apiKey` that happens to be
an OAuth access token still gets the full Claude Code request shape.

The hook is a models.json `!command` on purpose. A provider `apiKey` is re-executed on
every provider request, uncached, while an `auth.json` `!command` is cached for the whole
process and only re-runs after a 401. Per-request resolution is what lets a switch land
on the next request.

## Inside Prime Agent: the /account extension

`app/extension` is a Prime Agent extension, linked into `~/.prime/agent/extensions/pi-pool`
by the root installer. It uses only the public extension API, so a Prime Agent update
needs nothing re-applied. Earlier versions also patched Prime's bundled JavaScript for
the tray line. Prime 0.9.5 ships as one compiled binary, so that patch is gone.

| part | what it does |
|---|---|
| `/account` | pick this session's account, or follow the pool. Usable accounts are listed first |
| account line | one widget line by the editor: `account <email> 5h 25% · week 7% · fable 12%`, plus `→ <email>` when the next request switches. Refreshed at session start, on model change, after every turn, and every 60 seconds |
| login adoption | at session start it runs `pi-pool adopt-logins` (next section) and tells you if it moved a login |
| refusal probe | at session start it runs `pi-pool probe`, which sends one free `count_tokens` request per account with a valid token, at most every 6 hours. A refused account gets a 24h cooldown in the pool and `enforcedUntil` in tokenmaxxing's index, so supervised `claude` sessions avoid it too |

Prime 0.9.5 keeps `setStatus` text but its footer never draws it, which is why the account
line is a widget.

## A stored /login would bypass the pool

Prime resolves a provider's key from `auth.json` first and runs the models.json
`!command` only when `auth.json` has nothing for that provider. A `/login` for
`anthropic` or `openai-codex` therefore silently takes every request away from the pool.

`pi-pool adopt-logins` moves such a login out of `auth.json` into `fallback.json`, under
Prime's own `auth.json.lock`. It only touches providers whose models.json `apiKey` is the
pool hook. The login still serves as the fallback: when no pooled account can serve, the
hook refreshes and returns it (both providers). The extension runs this at every session
start, so a new `/login` is adopted the next time a session starts. A worker that already
holds the login in memory keeps using it until its session is rebuilt.

## Codex WebSocket reuse after a switch

Prime caches one Codex WebSocket per session, keyed by session id only. After the pool
moves a session to another Codex account, requests keep riding the open socket, which
was authorized as the old account, until the socket closes (idle timeout or an error).
If that matters, set `"transport": "sse"` in `~/.prime/agent/settings.json`: every
request then carries the current token, at the cost of the WebSocket's cached context.

## Config

`~/.config/pi-pool/config.json`, defaults in `DEFAULTS` (vend.py): `refresh_skew_sec`,
`five_hour_max_pct`, `seven_day_max_pct`, `cooldown_sec`, `session_penalty`,
`active_account_penalty`, `allow_active_account`, `switch_models`, `pin_ttl_sec`,
`active_session_sec`, `refused_cooldown_sec`, `probe_interval_sec`.
v1's `hold_sec`, `switch_improvement`, `assignment_scope` and `mode` are gone with the
per-process mode and the per-session balancing they tuned.

## Safety properties

- Prime receives access tokens only. Refresh tokens stay in private stores and rotation journals.
- A refresh takes tokenmaxxing's own flock and writes the rotation straight back.
- Rotations are journalled to `rotations/` before the write; a crash in that window is
  healed on the next vend.
- The pool flock is never held across a refresh, so `pi-pool use` never queues behind one.
- Every wait is budgeted under pi's 10s hook timeout.
- A failure on either provider degrades to `fallback.json` (your own login, a separate
  grant family) rather than "No API key found".

## Footguns

- `/login` writes an entry back into `auth.json`, which outranks the pool hook until the
  next session start adopts it (or run `pi-pool adopt-logins`).
- `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` in the environment outrank the hook.
- `pi-pool use` needs a session. Outside one, pass `--session <id>`.
- Third-party harness usage meters against each account's own quota.

## Rollback

Remove the extension link `~/.prime/agent/extensions/pi-pool` and restore the previous
provider configuration from the installer's external backup to stop using the pool hook.
`fallback.json` holds any adopted login; copy an entry back into `auth.json` to restore it.
Do not copy files over the installed source symlinks.

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
  install.py               copies a commit into ~/.local/share/pi-pool (next section)
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

## Install, update and roll back

Prime never runs files from this checkout. `install.py` copies a commit into its own
folder and points the runtime links at it, so an edit here is not live until it is
committed and installed. On 2026-10-08 a half-done edit in the checkout broke every
session from 17:45 to 17:59, because the links pointed at source.

```sh
/usr/bin/python3 -B components/pi-pool/install.py            # install HEAD
/usr/bin/python3 -B components/pi-pool/install.py --ref <sha>  # install another commit
/usr/bin/python3 -B components/pi-pool/install.py rollback     # back one release, or to the old links
/usr/bin/python3 -B components/pi-pool/install.py status
```

`install` takes these steps.

1. `git archive` exports `components/pi-pool` at the commit into a staging folder.
   Uncommitted edits never ship.
2. The pool's Python tests run in that folder. A failure stops here and changes nothing.
3. The folder becomes `~/.local/share/pi-pool/releases/<tree id>`, read-only. The id is
   the commit's tree id for this directory, so installing the same code twice reuses it.
4. The runtime links point at `~/.local/share/pi-pool/current`. Then `current` flips to
   the new release in one rename, and the release it replaced becomes `previous`.
5. Both token hooks run through `~/.config/pi-pool/bin/pi-pool-token`. If either hook
   exits nonzero, hangs past 10 s or is missing, `current` and the links go back to where
   they were and the command exits 1. Only token lengths are read.

The first install saves the links it replaced in
`~/.local/share/pi-pool/links-before-install.json`. `rollback` with no `previous` puts
those links back and removes `current`.

The installer owns these links. It refuses to replace anything at these paths that is
not a link.

```text
~/.config/pi-pool/vend.py           -> ~/.local/share/pi-pool/current/vend.py
~/.config/pi-pool/app               -> ~/.local/share/pi-pool/current/app
~/.config/pi-pool/bin               -> ~/.local/share/pi-pool/current/bin
~/.local/bin/pi-pool                -> ~/.local/share/pi-pool/current/bin/pi-pool
~/.prime/agent/extensions/pi-pool   -> ~/.local/share/pi-pool/current/app/extension
```

Prime's `models.json` names `~/.config/pi-pool/bin/pi-pool-token`, so it follows
`current` with no edit. `pi-pool enable` writes that same link path when it exists.
State stays where it is: `state.json`, `pi-pool.log`, `config.json`, `fallback.json`,
`rotations/` and `backups/` under `~/.config/pi-pool`, and the accounts under
tokenmaxxing. The installer keeps the 10 newest releases plus `current` and `previous`.
A running session keeps the extension code it loaded, from its own release, until it
is rebuilt; a new session loads `current`.

For a custom state directory, pass the same `PI_POOL_DIR` to the CLI and Prime Agent.
The CLI rejects state roots inside the code directory.

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
    pi-pool refresh [<email|id> ...] [--provider p] [--json | --stream]
                                  read usage now for every account, or the named ones (needs --provider)
    pi-pool off <email|id> [--provider <p>]   keep an account pooled but never pick it (`ls --json` shows `disabled`)
    pi-pool on <email|id> [--provider <p>]    let the pool pick it again
    pi-pool rm <email|id> [--provider <p>]    `tokenmaxxing rm`, then drop its pins and seat here
    pi-pool login [<email|id>] [--provider <p>] [--timeout <sec>]
                                  add an account (`tokenmaxxing add`) or sign one in again (`tokenmaxxing auth`)
                                  for a browser: stdout is JSON lines ({"event":"url"} with the link and the
                                  Codex device code, {"event":"retry"}, one {"event":"done","ok":...}); stdin takes
                                  one pasted Claude code per line, and closing stdin cancels
    pi-pool resets [<email|id> ...] [--json]   read each Claude account's banked usage-limit resets (spends nothing)
    pi-pool reset <email|id> [--grant <id>] [--json]   spend one banked reset
    pi-pool probe [--force]       check every Claude account for an API refusal (no token refresh)
    pi-pool limited --until <epoch sec> [--provider p] [--session id]
                                  the provider answered 429 for this session's account; prints the next account or null
    pi-pool refused <error text> [--provider p] [--session id]
                                  an account-level refusal (terms, OAuth off) cools this session's account down; prints the next account or null
    pi-pool log [n]               last n pool events
    pi-pool config / set <k> <v>

`--session` takes a session uuid, a uuid prefix, or the short active id.

`ls --json` names the pool `pin` next to the `seat`. Its rows also carry what `status` draws: `tier` (`max 20x`, `pro`), `windows`
(one entry per usage window in display order, each with `kind` session, weekly or model,
`label`, live `pct`, `resets_at` in epoch seconds or null, `window_sec`, `sampled_at`),
`usage_at` and `usage_age_sec`, `sessions` (vends in the last hour), `cooldown_until`
and `cooldown_reason` for a refused account, and `limited_until` for an account with a 429 on file.

`refresh` reads usage now for every account, or the named ones. `tokenmaxxing status`
cannot do this: it skips a Claude account read in the last 90 s to 15 min and reports it
as `cached`. So `refresh` runs `app/usage-read.ts` with tokenmaxxing's own Bun, once per
provider. That script imports tokenmaxxing's own read and save functions from the installed
release (found through the `tokenmaxxing` wrapper), reads four accounts at a time, and saves
each result under tokenmaxxing's pool lock. It still waits out a rate limit the usage
endpoint set, and reports it with the time of the next read. If an auto-update renames a
function it calls, it fails with the missing name, and the contract test in
`tests/test_core.py` fails too. It writes only tokenmaxxing's usage figures and moves no
seat or pin. tokenmaxxing may refresh an expiring store under its own lock while it reads.

`--stream` prints one JSON line per event while the reads run: `accounts` (the list),
`reading`, `read` with `ok` and `usage_at` or `reason` and `retry_at` (epoch seconds),
`error`, and a final `end`. Every line carries `provider`, and `reading` and `read` carry
`email`. A read still running after 180 s is reported as not finished. `--json` prints one
report at the end. Claude usage is also sampled every minute by
tokenmaxxing's `check` timer; Codex usage only when tokenmaxxing samples it, so Codex
figures can be hours old.

## Banked resets

Anthropic gives some Claude accounts banked usage-limit resets (program `cedar_ember`,
for example "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max"). The contract
comes from the CLIProxyAPI Management Center (`src/services/api/claudeResetGrants.ts`,
`resetGrantOperations.ts`) and was checked against live accounts.

- `resets` calls `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` as each account and saves
  the parsed `cedar_ember` block in `resets.json`; `ls --json` shows it as `resets` on Claude
  rows. One grant that does not parse rejects the account's whole block. A failed read keeps
  the last good grants and adds `error`.
- Anthropic decides eligibility by client. The calls send Claude Code's own User-Agent with
  the installed version (`claude-cli/2.1.289 (external, cli)`); pi-pool's plain User-Agent
  makes every account read as ineligible with reason `surface`.
- `reset` reads the organization (`GET /api/oauth/profile`) and the grants, and sends nothing
  when a grant cannot be spent (paused, not usable now, none left, needs the account to be
  limited, not started, expired, cooldown). Otherwise it writes the claim, with a new
  `request_id`, to `reset-claims.json` before it calls
  `POST /api/organizations/<org>/reset_rate_limits` with `{program, grant_id, request_id}`.
  The answer is one of `reset`, `already_used`, `not_limited`, `cooldown`, `ineligible`,
  `unavailable`; 429 and 401/403 mean nothing was spent.
- No answer (timeout, network) leaves the claim open. Running `reset` again within 10 minutes
  resends the same `request_id`, which Anthropic counts once. A refusal on such a retry does
  not settle the claim, because the first POST may have spent the reset. After 10 minutes the
  next `reset` compares the grant's `resets_left` with the count before the claim, and records
  whether the reset was spent.
- `reset.lock` allows one claim at a time on this Mac. Exit codes: 0 reset, 1 not reset or
  blocked, 3 unknown outcome.

## Which account a request gets

First match wins, per provider:

| # | source | set by | yields when |
|---|---|---|---|
| 1 | session pin | `/account`, `pi-pool use` | the account cannot serve. With `--force`, only when its credential cannot serve (needs re-auth, off, refusal cooldown) or the provider answered 429 (`limited`) |
| 2 | pool pin | `pi-pool pin` | the account cannot serve: depleted, limited, in cooldown, needs re-auth, or off |
| 3 | codex plan upgrade | plan tiers `free < plus < pro < team` | no usable codex account sits on a higher plan than the seat |
| 4 | seat | the pool itself | the seat cannot serve |
| 5 | best candidate | score | never |
| 6 | last resort | no account is usable | a depleted account the provider still serves (no 429 on file, every window under 100%) is vended, least used first; `pi-pool limited` names it as `next`. When none serves, the account whose limits reset first is vended anyway, so the request gets the provider's 429 and reset time instead of an auth error. Dead logins, disabled accounts and refusal cooldowns are never vended. No account left is an error |

A pin that yields writes nothing, so it re-applies by itself the moment the window
resets or the limit expires. `pi-pool who` names the pin it is shadowing and why. Every
vend that changes a session's account logs one `vend` line with `reason`, the yielded pin
in `shadowed`, the cause in `why` (`depleted`, `limited`, ...) and the `previous` account.

## A 429 moves the session in the same turn

Usage figures come from tokenmaxxing samples that can be 15 minutes old, so the provider's
own 429 is the first sign that an account is used up. The extension handles it on
`message_end`:

1. An assistant error with status 429 and a `retryAfterMs` on a pooled provider runs
   `pi-pool limited --provider <p> --until <now + retryAfterMs>`.
2. `limited` finds the account the session tree last vended, writes
   `providers.<p>.limits.<account> = {until, at, session}` to `state.json` under the flock,
   logs a `limited` line, and prints `{"account", "until", "next"}`.
3. When `next` names an account, the extension returns the message without `retryAfterMs`
   and without the "Try again in" phrase. Prime's usage wait then pings after about one
   second instead of sleeping until the reset, and that ping's hook call vends `next`.
4. When `next` is null, the message stays as it is and Prime waits for the provider's reset.

The limit lives in `state.json`, so a restarted worker or daemon still skips the account.
The hook prunes it when it expires. A successful `pi-pool login` for the account drops it,
since the 429 belonged to the replaced credential. `tests/native/swap.mjs` runs this against a copied
Prime install: request 1 gets a 429 on one Codex account, request 2 of the same turn uses
the other one, and a restarted Prime process goes straight to the other account.

## An account-level refusal moves the session the same way

Some errors fail every request on one account whatever the prompt. Prime treats a 400 or
403 as permanent, so without the pool the turn ends there. On 2026-10-08 a newly added
Claude account answered every turn for 3 minutes with a 400: "We've updated our Consumer
Terms and Privacy Policy. You'll need to accept them in claude.ai". The extension handles
these on `message_end` too:

1. An assistant error with status 400 or 403 on a pooled provider runs
   `pi-pool refused --provider <p> <error text>`.
2. `refused` reads the text (`account_refusal`). Terms not accepted is `needs terms`; OAuth
   turned off for the organization is `oauth not allowed for organization`. Any other text
   prints `{"reason": null}` and changes nothing.
3. For a refusal it cools the account the tree last vended down for `refused_cooldown_sec`,
   with the reason in `cooldown_reasons`, logs a `refused` line, and prints
   `{"account", "reason", "next"}`.
4. When `next` names an account, the extension marks the failure a rate limit, so Prime's
   usage wait retries in about a second and that retry's hook call vends `next`.

Settings > Accounts shows a `needs terms` account as "Needs terms". To bring it back, sign
in to claude.ai as that account, accept the terms, then choose Check again (`pi-pool probe
--force`, which sends that account a one-token message) or sign it in again (`pi-pool
login`). `FIXTURE_FAILURE=terms node tests/native/swap.mjs` runs this against a copied Prime
install, and with `FIXTURE_EXPECT=baseline` it shows the turn failing without the extension.

Step 3 exists because the seat otherwise moves only when it cannot serve. A free codex
account taken while the paid one was depleted would hold every unpinned session after
the paid window resets, and the API refuses several models on a free plan with a 400
"not supported when using Codex with a ChatGPT account". The upgrade moves the seat
(reason `seat_upgrade`) and touches no pin. Anthropic accounts carry no plan, so the
step never fires there.

Score, lowest wins: `max(5h%, 7d%) + 8 per session that vended from it in the last
hour + 15 if a tokenmaxxing-supervised session runs on it`. Excluded: needs-reauth,
depleted (>=95% 5h or >=98% 7d or the Fable cap), limited (a 429 on file), and accounts in cooldown. The Fable cap
only counts for a session tree that runs Fable: the `/account` extension records each
session's model (`pi-pool model`) at session start and on every model change, and a tree
with no Fable model ignores the cap. A tree with no recorded model keeps it. A cooldown
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
| 429 swap | on a 429 it runs `pi-pool limited` and, when another account can serve, drops the reset from the message so Prime retries in about a second on that account (see "A 429 moves the session in the same turn") |
| hook retry | a turn that failed with "Failed to resolve API key ... pi-pool-token" loses Prime's lifecycle-failure tag, so Prime retries it like any unclassified error |
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
- Every wait is budgeted under pi's 10s hook timeout. Prime measures that timeout by the
  wall clock and drops the hook's stderr. A hook it kills logs one `hook_killed` line with
  the stack it was in, `wall_sec` and `awake_sec`. A `wall_sec` far above `awake_sec` means
  the Mac slept while the hook ran. Prime 0.9.8 tags that failure an agent lifecycle failure
  and never retries it, so the extension takes the tag off and Prime's own retry runs the
  hook again, up to `retry.maxRetries` times (`tests/native/hook-timeout.mjs`).
- A writer killed between its write and its rename leaves `<file>.tmp.<pid>`. The next
  save of that file removes every such file whose pid is gone.
- A failure on either provider degrades to `fallback.json` (your own login, a separate
  grant family) rather than "No API key found".

## Footguns

- `/login` writes an entry back into `auth.json`, which outranks the pool hook until the
  next session start adopts it (or run `pi-pool adopt-logins`).
- `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` in the environment outrank the hook.
- `pi-pool use` needs a session. Outside one, pass `--session <id>`.
- Third-party harness usage meters against each account's own quota.

## Rollback

`install.py rollback` puts the previous release back in one rename and checks both hooks.
With no previous release it puts back the links the first install replaced.
To stop using the pool hook, remove the extension link `~/.prime/agent/extensions/pi-pool`
and restore the previous provider configuration from your own backup of `models.json`.
`fallback.json` holds any adopted login; copy an entry back into `auth.json` to restore it.
Do not edit or copy files under `~/.local/share/pi-pool`; install a commit instead.

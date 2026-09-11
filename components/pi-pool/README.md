# pi-pool - account pooling for Prime Agent (pi)

Every pi session draws its Claude and Codex credentials from the accounts already
pooled in `tokenmaxxing`, instead of one fixed login. You can move one session to a
different account while it runs, with no `/login` and no restart.

## Source and runtime state

This directory is the maintained pi-pool source for Prime Agent 0.9.4.
Python uses the macOS `/usr/bin/python3` standard library. The extension uses
Prime Agent's public types and its `@earendil-works/pi-tui` dependency.
Node from the Prime Agent installation runs the patch syntax checks and native tests.
No account store or credential is included here.

```text
checkout/components/pi-pool/
  vend.py                  code root from realpath(__file__)
  app/                     patcher, UI helper, /account extension
  bin/                     executable, relocatable Python wrappers

PI_POOL_DIR or ~/.config/pi-pool/
  config.json, state.json   configuration, pins, seats and session records
  lock, pi-pool.log         lock and event log
  rotations/, fallback.json, backups/   private runtime data
```

`PI_POOL_DIR` selects state only. It never selects Python modules or executables.
The wrappers and patcher resolve symlinks before they locate source files.
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
The CLI rejects state roots and patch targets inside this source directory.

The patcher logs to the state directory. Bundle backups (`*.bak-pi-pool`) and
staged JavaScript stay beside the target Prime Agent bundle, outside this checkout.
It scans only top-level bundle `.js` files, not backup suffixes or state directories.
The extension link points to source. The copied UI helper reads runtime state, not
its own directory. `patch --check` compares the helper with source, and `patch`
refreshes a stale helper even when every bundle replacement is already current.
Running processes still need a restart to load changed JavaScript.

## External credential dependencies

pi-pool depends on the user's existing tokenmaxxing stores under
`~/.config/tokenmaxxing`. This repository does not install or seed those stores.

| dependency | use |
|---|---|
| `accounts.json` | Claude account ids, emails, usage, active account and each `keychainItem` service name |
| macOS Keychain | Claude credentials, read and written through `/usr/bin/security` using `USER` as the keychain account |
| `Claude Code-credentials` Keychain service | Read-only credential for the account currently active in Claude Code |
| `lock` | tokenmaxxing's Claude refresh lock |
| `codex-accounts.json` | Codex account ids, emails, plans, usage and each `credFile` name |
| `codex-creds/<credFile>.json` | Parked Codex credentials and in-place refresh results |
| `codex-lock` | tokenmaxxing's Codex refresh lock |
| `codex-live/` and `~/.codex/auth.json` | Detect accounts owned by a live Codex CLI session |

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

    pi-pool                       pool status, scores, and which session is on what
    pi-pool status --provider openai-codex
    pi-pool watch [sec]           repaint status every sec seconds
    pi-pool use <email|id> [--force] [--follow] [--provider p] [--session id]
    pi-pool who [--json] [--session id]
    pi-pool ls [--json] [--provider p] [--session id]
    pi-pool pin <email>           force EVERY session onto one account
    pi-pool unpin
    pi-pool switch                drop the seat; the next request re-picks
    pi-pool enable openai-codex   wire the codex provider into models.json
    pi-pool patch [--check]       put the pool into the TUI; 0 patched, 1 not, 2 anchors missing
    pi-pool unpatch
    pi-pool log [n]               last n pool events
    pi-pool config / set <k> <v>

`--session` takes a session uuid, a uuid prefix, or the short active id.

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

Score, lowest wins: `max(5h%, 7d%) + 8 per session already on it + 15 if another tool
is live on it`. Excluded: needs-reauth, depleted (>=95% 5h or >=98% 7d), and accounts
in cooldown after a failure.

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

writes the provider entry into `~/.prime/agent/models.json`. It leaves `auth.json`
and any legacy `fallback.json` unchanged. Prime keeps ownership of the native login.
The entry needs `baseUrl`. A provider entry with only `apiKey` fails `validateConfig`
and takes every model down, not just codex.

Codex credentials live in `~/.config/tokenmaxxing/codex-creds/`. A rotation takes
tokenmaxxing's `codex-lock` and is journalled before the write. The account
`~/.codex/auth.json` names is read but never refreshed here, and an account with a live
codex session is skipped: the codex CLI owns those rotations.

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

## What `pi-pool patch` changes

Three bundle files and one extension symlink:

| target | file | what it does |
|---|---|---|
| recovery | `dist/bundle/chunk-*.js` | native request-auth retries and fresh compaction credentials |
| tui | `dist/bundle/chunk-*.js` | pool display, 65% Session column, command-first auth, and request-auth stream adaptation |
| codex-websocket | `dist/bundle/openai-codex-responses-*.js` | a separate socket cache entry for each session and account |
| extension | `~/.prime/agent/extensions/pi-pool` -> `app/extension` | the `/account` command |

The Agents view reserves 65% of the table width for session names. Model and Activity
use the remaining space after Cost and Age. On narrow terminals, names stop growing
when the reserved Cost and Age columns need the space.

The patcher locates readable esbuild output by function anchors. Every edit carries a
`/* pi-pool */` marker. It validates all anchors, original backups, and staged syntax
before replacing a bundle. It installs exports before imports and removes imports first.
Interrupted apply or unpatch can run again. Unknown changes or mismatched backups stop
without replacing a bundle. `--check` reports 0 for patched, 1 for pending, and 2 for an
unsupported shape or backup.

`prime-agent update` replaces the package. The existing `com.sieun.pi-pool-patch`
LaunchAgent reapplies the maintained patch. Applying a patch does not restart a daemon.
Running processes retain their loaded code.

A usable command credential skips native fallback lookup and refresh. Command failures
use the existing native retry budget. Known-stale credentials require `/login`.
Compaction rereads the key and headers on every attempt. It preserves each summary's
request identity and stops uncompressed continuation after auth exhaustion.

Request credential commands run asynchronously with the existing 10-second timeout and
1 MiB output limit. User abort does not kill an in-flight credential owner. The owner
can finish persisting a rotated grant, but its result cannot trigger fallback or a
provider request after abort. This does not guarantee that all descendants exit in 10 seconds.
Generic configuration and header commands retain their native behavior.

Run isolated native regressions as described in [tests/native/README.md](tests/native/README.md).

The display reads only local files, cached by mtime, at most one stat per second per file.

## Patch updater LaunchAgent

`app/install_patch_agent.py` prints the `com.sieun.pi-pool-patch` plist by default.
`--prime-root` or `PI_POOL_PRIME_AGENT_ROOT` selects a package without PATH lookup.
`--write` builds a generated service runtime and writes the plist under
`~/Library/LaunchAgents`. It does not call `launchctl` or run the patcher.

macOS can deny LaunchAgents access to source under `Documents`, even when the same
command works in a terminal. The service runs generated files outside that directory.
The repository remains the source of truth.

```text
repository/components/pi-pool/app/
  patch_prime_agent.py + pi-pool-status.js
                 |
                 | install_patch_agent.py --write
                 v
~/.local/share/sieun-pi/pool-patch/app/
  patch_prime_agent.py + pi-pool-status.js   generated code only

~/.config/pi-pool/                          state and logs only
```

The generator copies only those two files. It does not copy the extension, credentials,
state or backups. Repeated writes retain unchanged files and refresh changed source files.
An unknown entry or symlink in the runtime `app` directory stops the write without deleting it.
The generated code root and state root stay separate, so the source-write protections still apply.

The service invokes the generated patcher with `apply --bundle-only`.
This mode reads its helper from the generated runtime and never reads, installs, removes
or retargets the `/account` extension. `check --bundle-only` checks only bundle patches
and that helper. Normal source `patch`, `patch --check` and `unpatch` still manage the extension.
Logs stay under the explicit `PI_POOL_DIR` in the generated environment.

The plist preserves the updater schedule. It watches the package parent and `package.json`,
waits 20 seconds before patching, runs at load and every 1800 seconds, and uses a
30-second throttle. HOME, PATH, `PI_POOL_DIR`, `PI_POOL_PRIME_AGENT_ROOT` and
`PRIME_AGENT_CODING_AGENT_DIR` are explicit in its environment.

Only the coordinating root session installs or reloads this agent in the live HOME.
From the repository root, inspect the dry run before writing the generated files.

```text
/usr/bin/python3 -B components/pi-pool/app/install_patch_agent.py
/usr/bin/python3 -B components/pi-pool/app/install_patch_agent.py --write
```

For a new agent, bootstrap the generated plist manually.

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sieun.pi-pool-patch.plist"
```

For an already loaded agent, unload it before bootstrapping the new plist.

```sh
launchctl bootout "gui/$(id -u)/com.sieun.pi-pool-patch"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sieun.pi-pool-patch.plist"
```

After changing the source patcher or helper, run the generator with `--write` again.
Otherwise the service retains the previous generated code and helper.
Changing the Node installation path also requires reloading the regenerated plist.
The updater does not restart Prime Agent daemons after a patch.

## Config

`~/.config/pi-pool/config.json`, defaults in `DEFAULTS` (vend.py): `refresh_skew_sec`,
`five_hour_max_pct`, `seven_day_max_pct`, `cooldown_sec`, `session_penalty`,
`active_account_penalty`, `allow_active_account`, `switch_models`, `pin_ttl_sec`.
v1's `hold_sec`, `switch_improvement`, `assignment_scope` and `mode` are gone with the
per-process mode and the per-session balancing they tuned.

## Safety properties

- Prime receives access tokens only. Refresh tokens stay in private stores and rotation journals.
- A refresh takes tokenmaxxing's own flock and writes the rotation straight back.
- Rotations are journalled to `rotations/` before the write; a crash in that window is
  healed on the next vend.
- The pool flock is never held across a refresh, so `pi-pool use` never queues behind one.
- Every wait is budgeted under pi's 10s hook timeout.
- An anthropic failure degrades to `fallback.json` (your own login, a separate grant
  family) rather than "No API key found".

## Footguns

- `/login` writes an entry back into `auth.json`. On a patched bundle the models.json
  hook still wins; on an unpatched one the login silently disables the pool.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` in the environment outrank the hook.
- `pi-pool use` needs a session. Outside one, pass `--session <id>`.
- Third-party harness usage meters against each account's own quota.

## Rollback

    pi-pool unpatch

This restores validated bundle backups and removes the pool helper and extension link.
It does not change credentials or provider configuration. Restore the previous
provider configuration from the installer's external backup if you want to stop
using the pool hook. The deprecated `vend.py.v1` is not part of this source.
Do not copy files over the installed source symlinks.

# sieun-pi

Custom Prime Agent extensions, skills and account-pool tools in one source package.
The supported host is **Prime Agent 0.9.4**. Upstream Pi compatibility is not claimed.

```text
Public Git source or installed npm package
  ├─ skills/                    -> ~/.prime/agent/skills/<name>
  ├─ components/pi-pool/         -> pool source links and /account
  ├─ components/virev/           -> one global Virev extension
  ├─ components/user-history/    -> one global whole-package link
  └─ config/                    -> rules and new-profile defaults

~/.prime/agent/virev-projects.json -> explicit project policy selection
Credentials, settings, sessions and account stores stay outside the source tree.
```

## Install from GitHub

Use Node.js 22.8 or later and Python 3.11 or later on macOS or Linux.
Native chat runs as a standalone loopback server on macOS and Linux. It never opens a browser. Keychain account operations and the updater require macOS.
Install the Prime Agent 0.9.4 host separately. Provider credentials and account enrollment are not included.

```sh
npm install --global --ignore-scripts 'git+https://github.com/sieu-n/sieun-pi.git'
sieun-pi source
sieun-pi plan --out "$HOME/sieun-pi-plan.json"
```

Review that plan, then apply it.

```sh
sieun-pi apply --plan "$HOME/sieun-pi-plan.json"
sieun-pi verify
```

The Git URL does not need an npm publication or a machine-local dependency.
Installing the npm package does not change your Prime profile. Only explicit installer commands change source links.
Existing settings stay byte-for-byte unchanged. New profiles get the defaults in `config/settings.example.json`.

Virev loads globally but applies `auto-sns-agent` policy only to configured projects.
To add that policy, pass `--project /absolute/path/to/auto-sns-agent` to `plan` and `verify`.
Existing project entries remain intact. Without `--project`, a new profile has no configured project policy.

Commands include `/account`, `/virev-reload`, `/what-did-i-say` and `/agent-chat`.
`/virev-status` does not exist. `/what-did-i-say` and `/agent-chat` print a URL for the current native session.

```sh
sieun-pi chat start    # detached server, default 127.0.0.1:5182
sieun-pi chat status
sieun-pi chat url
sieun-pi chat stop     # leaves native workers running
sieun-pi chat serve   # foreground server
```

The URL and port survive restarts. No browser opens automatically. The service stays separate from pi-pool's CLI/token hook. Custom instances accept `--port`, `--socket` and `--data-dir`. The extension accepts `--agent-chat-port`, `--agent-chat-socket` and `--agent-chat-data-dir`. See the component README for the private capability model and lifecycle rules.
Do not register this package through Prime's package settings as well as the source installer.
The `pi.extensions` and `pi.skills` metadata support resource discovery; they do not install pool tools or migrate old links.

## Develop and check

Use a Git checkout for development. Full checks also need uv, Bun and Node.js 22.13 or later for daily recap.

```sh
git clone https://github.com/sieu-n/sieun-pi.git
cd sieun-pi
npm run develop
npm run check
npm run build
npm run test:package
```

`develop` installs locked root, history, daily recap and skill development dependencies.
`source` prints the active source location. `check` runs source tests and type checks.
`build` runs checks, builds three Python wheels and packs the source npm tarball into `dist/`.
`test:package` installs that source artifact with production dependencies in an isolated HOME.
It checks native Prime loading twice, then repeats apply, updates source links, rolls back and uninstalls them.

Prime loads TypeScript and MJS from source. Its kernel installs the linked Python skills into its own environment.
The root `.venv` is only for development. The runtime SDK dependency uses the locked official 0.9.4 R2 release,
not the unavailable `prime-agent@0.9.4` npm registry version. `marked` is also a runtime dependency.

## Update, roll back and uninstall

Keep release source directories until their receipts are no longer needed.
Use a new, pinned install prefix for updates. Do not overwrite a source directory used by running sessions.
The [install guide](docs/install.md#update-with-a-separate-release-directory) has the versioned update commands.

```sh
sieun-pi rollback --receipt /absolute/path/to/receipt.json
sieun-pi uninstall --receipt /absolute/path/to/initial-receipt.json
```

`uninstall` restores the pre-install targets using the same receipt checks as rollback.
Roll back later updates first, in reverse order, using each release's installer.
Then remove the npm package with `npm uninstall --global sieun-pi` if you installed it globally.
Removing the npm package alone leaves broken source links.

The installer preserves credentials and unrelated files. It backs up replaced source and old project links outside the source tree.
It refuses changed targets or backups instead of overwriting later edits.
It never restarts sessions, patches Prime, or changes a service.

See [installation and rollback](docs/install.md), [account-pool setup](components/pi-pool/README.md),
[history and chat](components/user-history/README.md), [skill checks](skills/README.md), and [source provenance](docs/provenance.md).

## Shared source utilities

Other projects can depend on this public Git package and import `detectAgentIdentity` from `sieun-pi/agent-identity`
or `derivePrimeAgent` from `sieun-pi/prime-context`. These exports keep the Prime-specific source here.
Use `import.meta.resolve("sieun-pi/daily-recap/drifty_focus_export.py")` to locate the shared Drifty exporter.

## Optional daily recap

The daily recap component has a separate runtime and dependency lock. Its Node runtime needs version 22.13 or later. It is not part of source-link apply.
Preview its setup without loading a service or sending a Slack message.

```sh
sieun-pi daily-recap-setup
```

The preview writes nothing. `--write` stages the reviewed runtime and plist only.
It preserves existing `config.env` without reading it. A new config template disables posting.
Install its own locked npm dependencies and configure accounts only when you choose to enable it.
Read [the daily recap guide](components/daily-recap/README.md) before loading its service or running a report.
Source-link rollback does not restore that separate runtime or service.

## Automatic updates

Nothing needs re-applying after an update.

- Prime Agent: the pool's `/account` command, account line and login adoption are an extension that uses only the public extension API. A new session loads the current source.
- tokenmaxxing: its periodic check (`com.tokenmaxxing.check`, every 60 seconds) installs the newest npm release once a day. pi-pool reads tokenmaxxing's index schema version 2 and fails with the schema version in the error if a later release changes it.


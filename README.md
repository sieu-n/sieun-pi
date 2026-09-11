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
History/chat UI, Keychain account operations and the updater require macOS. The UI uses Aside.
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
`/virev-status` does not exist. The whole history package also registers `--agent-chat-socket`.
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

## Install or refresh the automatic updater

The LaunchAgent uses a generated copy outside Documents because macOS blocks its access to that source folder.
The copy contains only the patcher and its JavaScript helper. Skills, extensions and the CLI keep their source links.

Review the generated plist first. Run these commands from the source path printed by `sieun-pi source`.
Replace the Prime path with the installed host package directory, not this package's SDK dependency.

```sh
/usr/bin/python3 -B components/pi-pool/app/install_patch_agent.py --prime-root /path/to/installed/prime-agent
```

If the updater is loaded, stop it before writing its runtime files.

```sh
launchctl bootout "gui/$(id -u)/com.sieun.pi-pool-patch"
```

Generate the files and load the service.

```sh
/usr/bin/python3 -B components/pi-pool/app/install_patch_agent.py --prime-root /path/to/installed/prime-agent --write
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sieun.pi-pool-patch.plist"
```

After its normal 20-second delay, check `launchctl print "gui/$(id -u)/com.sieun.pi-pool-patch"` for exit 0.
Repeat this step after changing the patcher or helper. Source-link apply does not refresh the service copy.
This does not restart Prime sessions. Keep the old plist and runtime separately if you need service rollback.

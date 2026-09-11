# Install and manage source links

This installer targets Prime Agent 0.9.4. It does not install an interactive Prime host, configure accounts, or copy runtime state.
Use Node.js 22.8 or later and Python 3.11 or later. The installer supports macOS and Linux.
The history/chat UI, Keychain operations and LaunchAgent need macOS. Aside and provider credentials remain external requirements.

## Install the public Git package

```sh
npm install --global --ignore-scripts 'git+https://github.com/sieu-n/sieun-pi.git'
sieun-pi source
sieun-pi --help
```

No npm publication is required. The package has a `bin` command, source-file allowlist, and `pi.extensions`/`pi.skills` metadata.
The command skips dependency lifecycle hooks with `--ignore-scripts`. Do not use `--omit=optional`.
No dependency resolves to a path on the author's machine.

The root runtime dependencies include `marked@18.0.12` and the official Prime Agent 0.9.4 SDK tarball.
The registry returns E404 for `prime-agent@0.9.4`, so this package uses the versioned R2 URL in `package.json` and `package-lock.json`.
The matching release checksums are at [SHA256SUMS](https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4/SHA256SUMS).
The dependency supports history/session APIs. It does not replace your interactive host or its accounts.
The pinned SDK currently has two high-severity npm audit entries through `extract-zip`. No fix is available in that release.
Do not use it to extract untrusted archives.

For source development, clone the repository instead of modifying a global npm install.

```sh
git clone https://github.com/sieu-n/sieun-pi.git
cd sieun-pi
npm run develop
npm run check
npm run build
```

`develop` runs root `npm ci --ignore-scripts`, `uv sync --locked`, the frozen Bun skill install, and each component's `npm ci`.
It needs uv and Bun. `check` runs skill checks, root and pool Python tests, Virev Node tests, history and daily recap tests, TypeScript checks,
linear-ticket tests, poteto tests, and source syntax checks. It does not install missing dependencies.
`build` runs those checks, creates the three Python skill wheels, and writes the source npm tarball to `dist/`.

Prime's kernel bootstrap installs linked Python skills into its own kernel environment. Do not use the root `.venv` as the live kernel.
Packed npm artifacts contain runtime source. npm excludes the root `package-lock.json` from a tarball, so use the Git checkout for locked development.

## Prove an isolated profile

Keep the profile outside the source tree. Use an existing empty directory as the project.

```sh
PROFILE="$(mktemp -d)"
mkdir -p "$PROFILE/home" "$PROFILE/project"
sieun-pi plan --home "$PROFILE/home" --project "$PROFILE/project" --out "$PROFILE/plan.json"
sieun-pi apply --plan "$PROFILE/plan.json"
sieun-pi verify --home "$PROFILE/home" --project "$PROFILE/project"
sieun-pi apply --plan "$PROFILE/plan.json"
node "$(sieun-pi source)/scripts/prove_runtime.mjs" --home "$PROFILE/home" --project "$PROFILE/project"
```

The proof uses the installed package's Prime 0.9.4 SDK. It checks every custom skill, three extension entry points,
all four command registrations and the history flag. It reloads twice. It exercises the Virev guard and writing rules,
and verifies that a directory outside the configured project does not receive its Git policy.
It runs no model, account or MCP calls and opens no browser.

From a development checkout, `npm run test:package` packs and installs with production dependencies into two isolated prefixes.
It checks repeat apply, native loading, a release-to-release source-link update, rollback and uninstall.
`npm run prove:runtime -- --home ... --project ...` runs the loader proof against an already installed test profile.
These checks do not prove live OAuth, a running daemon chat, Aside availability, or upstream Pi compatibility.

## Plan and apply

Pause affected sessions before changing source links. Review the plan before apply.

```sh
sieun-pi plan --home "$HOME" --project /absolute/path/to/auto-sns-agent --out "$HOME/sieun-pi-plan.json"
sieun-pi apply --plan "$HOME/sieun-pi-plan.json"
sieun-pi verify --home "$HOME" --project /absolute/path/to/auto-sns-agent
```

Use a new plan filename each time. Omitting `--home` selects your HOME.
Plans cannot go under managed runtime directories. Inside a development checkout, use ignored `.work/`.
The Node CLI calls Python 3; `SIEUN_PI_PYTHON` can select another Python 3.11+ executable.
The direct equivalent is `python3 -B scripts/manage.py <command>` from the source tree.

The manifest installs these links.

- Each skill root and the auxiliary `skills/skills` directory goes under `~/.prime/agent/skills`.
- `config/AGENTS.md` and `config/pstack-models.json` go under `~/.prime/agent`.
- Pool `vend.py`, `app`, and `bin` go under `~/.config/pi-pool`. That parent stays a real directory.
- The pool CLI goes at `~/.local/bin/pi-pool`; its `/account` extension goes under `~/.prime/agent/extensions/pi-pool`.
- One global Virev entry links `~/.prime/agent/extensions/virev.ts` to `components/virev/extensions/virev.ts`.
- One global history link points `~/.prime/agent/extensions/user-history` at the whole `components/user-history` package.
  Its `pi.extensions` declaration loads `./extension/index.ts`. Both history commands use its sibling `src/` files.

Existing `settings.json` stays byte-for-byte unchanged. New profiles get an ordinary JSON file from `config/settings.example.json`.
Review its provider/model and Aside defaults before interactive use. Prime may rewrite this file atomically.
Credentials, `auth.json`, `models.json`, sessions, memories, account stores and unrelated files are outside installer ownership.

## Select project policy and migrate old links

Virev loads once globally. Project policy comes from `~/.prime/agent/virev-projects.json`.

```json
{
  "projects": [
    { "root": "/absolute/path/to/auto-sns-agent", "policy": "auto-sns-agent" }
  ]
}
```

`--project` adds that entry if absent. It preserves other entries and fields and refuses a conflicting policy for the same root.
Without `--project`, a fresh install writes `{"projects": []}`. It does not activate auto-sns-agent policy everywhere.
Virev's `VIREV_PROJECTS_FILE` environment override lets runtime tests read an isolated configuration.
The installer always manages the selected HOME's file; it does not redirect writes using that runtime override.

When you select a project, the plan includes receipt-backed removal of these old targets.

```text
<project>/.prime/agent/extensions/virev.ts
<project>/.prime/agent/ext-impl/virev
<project>/.prime/agent/virev-project.json
```

Their contents move to the receipt's backups. Unrelated project files stay in place.
There are no project-local Virev source links, implementation links or marker in the final layout.
To migrate another old project, plan again with its `--project` path. Prior configured entries remain intact.

The installer also removes the known legacy `~/.prime/agent/extensions/what-did-i-say` symlink only when its stored target
is the absolute path `<selected-home>/code/prime-agent-user-history`. It backs up the symlink without altering that source checkout.
A different target, including another directory named `prime-agent-user-history`, or a non-symlink fails for review.
Extra Virev extension registrations or matching extension/package settings entries also fail for review.
The installer does not guess how to remove unknown package registrations or rewrite unrelated settings.
Do not install duplicate resources through Prime package settings and source links at the same time.

## Update with a separate release directory

Do not run a global npm update over source used by active sessions. It replaces source before a receipt can preserve it.
Install a reviewed commit into a new prefix. Replace `REVIEWED_COMMIT` with its full Git commit hash.

```sh
REF=REVIEWED_COMMIT
PREFIX="$HOME/.local/share/sieun-pi/releases/$REF"
npm install --prefix "$PREFIX" --ignore-scripts "git+https://github.com/sieu-n/sieun-pi.git#$REF"
NEW="$PREFIX/node_modules/.bin/sieun-pi"
"$NEW" plan --home "$HOME" --project /absolute/path/to/auto-sns-agent --out "$HOME/sieun-pi-$REF-plan.json"
"$NEW" apply --plan "$HOME/sieun-pi-$REF-plan.json"
"$NEW" verify --home "$HOME" --project /absolute/path/to/auto-sns-agent
```

Review and verify the new release in an isolated HOME before that live apply.
Keep the old prefix, the new prefix and both receipts. Each release's CLI prints its own source path with `source`.
The update receipt backs up old link targets. It does not snapshot changes made inside a source directory.
Use a fresh Git checkout or package prefix for every release that needs source rollback.

## Resume, roll back and uninstall

Plans fingerprint sources and destinations. Apply rejects changed source, target, manifest or unsafe symlink parents.
Do not edit source while apply or rollback runs. Receipts and source backups stay under
`<home>/.local/state/sieun-pi/receipts/<plan-id>/` with private permissions.

```text
plan -> verify fingerprints -> record receipt -> move old target to backup -> publish new target
                                                   |
                                                   +-> interruption -> apply the same plan again

new release -> rollback its receipt -> old source links -> uninstall initial receipt -> original targets
```

If apply stops, run the same `apply --plan` command again. It verifies the journal and resumes.
Do not create a new plan to conceal an interrupted replacement.

```sh
/path/to/new-release/sieun-pi rollback --receipt /absolute/path/to/update-receipt/receipt.json
/path/to/initial-release/sieun-pi uninstall --receipt /absolute/path/to/initial-receipt/receipt.json
```

Use the CLI path for the release that created each receipt. Roll back later updates first, in reverse order.
`uninstall` is rollback of the initial installation. It restores any pre-existing targets instead of deleting them.
Only after source links have been restored should you remove the package, for example `npm uninstall --global sieun-pi`.
Keep backups until you have verified the restored setup. Do not delete a source prefix while a live link still targets it.

Rollback refuses changed installed targets or backups before restoring anything. Restore an interrupted rollback with the same command.
Unchanged pre-existing settings are outside rollback ownership, so later Prime settings edits stay intact.
If Prime changed a settings file that this installer created, rollback stops rather than deleting those changes.
Review and preserve that new data before retrying. Receipts do not undo edits inside source files.

Backups use filesystem renames. Replaced project source and HOME receipts must share a filesystem.
A cross-device replacement fails rather than copying an unreviewed directory. Keep receipts in their original paths.
Use the creating release's manifest and installer for rollback; do not edit its target ownership.
Protected runtime names inside an old source directory block migration. Move that state separately after reviewing its owner.

## Optional daily recap

The daily recap component has a separate runtime and dependency lock. Its Node runtime needs version 22.13 or later. It is not part of source-link apply.
Preview its setup without loading a service or sending a Slack message.

```sh
sieun-pi daily-recap-setup
```

The preview writes nothing. `--write` stages the reviewed runtime and plist only.
It preserves existing `config.env` without reading it. A new config template disables posting.
Install its own locked npm dependencies and configure accounts only when you choose to enable it.
Read [the daily recap guide](../components/daily-recap/README.md) before loading its service or running a report.
Source-link rollback does not restore that separate runtime or service.

## Patch and reload separately

The installer never patches a host package. Pool patching requires an explicit target installation.

```sh
PI_POOL_PRIME_AGENT_ROOT=/path/to/installed/prime-agent "$HOME/.local/bin/pi-pool" patch
PI_POOL_PRIME_AGENT_ROOT=/path/to/installed/prime-agent sieun-pi verify --check-patch
```

`--check-patch` runs only `patch --check`. A missing or unsupported host fails that check.
Provider model setup and account enrollment remain separate operations.
The LaunchAgent uses a generated runtime outside Documents because macOS blocks its access through a Documents source link.
Follow the [updater commands](../README.md#install-or-refresh-the-automatic-updater) after installing source links.
Stop a loaded updater before replacing its runtime or plist. Check its real exit code after the normal 20-second delay.

Source receipts do not restore a service plist, generated updater runtime or patched host bundle.
Keep matching copies before changing them. The source installer does not load, unload or rewrite a service.
Reload extensions or start a new Prime session after verification. Restart kernel workers at a safe boundary so Python uses linked source.
Virev's watcher may load source edits before a new build, so pause affected sessions before development changes.

# prime-sync

prime-sync makes the Prime setup the same on every box, so a chat or job sees the same skills, rules, harness notes and corrections wherever it runs.
One run takes a few seconds, and a timer runs it every minute on each box: `prime-sync.timer` under systemd on Linux and `com.sieun.prime-sync` under launchd on macOS.
Prime and the chat read only local files, so prime-sync writes those files in place and neither of them knows it exists.

## What one run does

1. It moves the sieun-pi checkout to GitHub `main` when the checkout is on `main` and behind it. Local commits that GitHub lacks are replayed on top in the object store with `git merge-tree`, the way a rebase would, and they still reach GitHub the usual way, since prime-sync never pushes the checkout. A dirty file on a path the move changes goes into a stash for the move and comes back on top. A conflicting commit or dirty file, an untracked file in the way, or a commit made during the run leaves the checkout as it was, puts a `skipped:` line in `sync.log`, and the next run tries again.
2. It points every home link in `install-manifest.json` at the checkout, which covers the skills (the board skill among them), `~/.prime/agent/AGENTS.md`, `pstack-models.json` and the two extensions. A copied folder or file in a link's place is deleted, and a skill link into the checkout that the manifest no longer lists is removed.
3. It sets each key of `config/settings.shared.json` in `~/.prime/agent/settings.json`, which keeps the default model, thinking level, retry policy and skills list equal. MCP servers stay per box, because their commands are box paths. A `skills` entry resolves against `~/.prime/agent`, and Prime does not expand `~` after the `-` prefix, so `-../../.agents/skills/find-skills` hides `~/.agents/skills/find-skills` on every box and `-~/.agents/...` hides nothing (checked with a fresh `prime-agent -p --no-session` on us-metal02, 2026-10-18).
4. It merges the global harness entries in `~/.prime/agent/harness/harness_state.json` and the corrections ledger in `~/.prime/agent/browser-chat/corrections.json` with the private repo `sieu-n/prime-shared-state`, writes the result locally and pushes it.

## How the merge works

1. The state repo holds one file per entry: `harness/<kind>/<id>.json`, `harness/refinements/<id>-<hash>.json` and `corrections/<id>.json`.
2. The ref `refs/prime-sync/base` in the box's clone remembers the shared state the box last took in, so each entry merges three ways between that base, the local file and GitHub.
3. A side that changed an entry since the base wins. When both sides changed it, the newer `updated_at` (for a correction, its newest `at`) wins, and a delete against an edit keeps the edit.
4. A box that has never synced takes the shared copy of every entry both sides hold and adds the entries only it holds, so joining deletes nothing.
5. A run that would delete more than half of the shared entries of one file stops that file and says so in its status. This hard limit guards data integrity, because a truncated or reset local file must not empty every box.

## How it writes Prime's and the chat's files

1. Prime writes `harness_state.json` from each kernel by reloading it when its mtime changed, editing it in memory and replacing it atomically, with no lock (`prime-agent-runtime/src/rlm/harness.py`, `HarnessState.save`).
2. prime-sync replaces the file the same way, and only when the mtime is unchanged since it read the file. It reads the file again 2 seconds later, and if a Prime write landed in between, it leaves the base where it was, so the next run merges again and loses nothing.
3. The chat writes the ledger under the `corrections.json.lock` directory (`components/user-history/src/locked-json.ts`), and prime-sync takes the same lock for its read, merge and write.
4. Two boxes that both run the chat could each number a new correction `c100`, and the newer one would win. Only one box runs the chat, so this does not happen today.

## Install and use

```sh
python3 -B components/prime-sync/install.py --ref "$(git rev-parse HEAD)"   # or: node scripts/cli.mjs sync install --ref <sha>
node scripts/cli.mjs sync                                                      # one run now, with its report
cat ~/.local/share/prime-sync/status.json                                      # the last run
```

1. The installer copies `sync.py` from the commit to `~/.local/share/prime-sync/`, so a later checkout change cannot break the timer until someone installs it.
2. The timer runs the Python that ran the installer. On the Mac that must be `/opt/homebrew/bin/python3`, because macOS refuses a launchd job under `/usr/bin/python3` access to `~/Documents`, where the checkout lives.
3. `~/.config/prime-sync/sync.json` names the checkout, the state repo and its clone, and the agent folder. The host name comes from `~/.config/sieun-pi/hosts.json` when this box is listed there.
4. `sync.log` in the same folder gets one line for each run that changed something or hit an error.
5. The installer copies `gh auth token` into `~/.config/prime-sync/github-token` (mode 0600), and every git call of a run reads GitHub credentials from that file. A launchd job on the Mac cannot open the login keyring that the gh helper uses, and on 10-18 at 03:10Z one run failed its fetch with "Device not configured". Run the installer again after `gh auth login` changes the token.

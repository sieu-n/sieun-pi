# prime-sync

prime-sync makes the Prime setup the same on every box, so a chat or job sees the same skills, rules, harness notes and corrections wherever it runs.
One run takes a few seconds, and a timer runs it every minute on each box: `prime-sync.timer` under systemd on Linux and `com.sieun.prime-sync` under launchd on macOS.
Prime and the chat read only local files, so prime-sync writes those files in place and neither of them knows it exists.

## What one run does

1. It moves the sieun-pi checkout to GitHub `main` when the checkout is on `main` and behind it. Local commits that GitHub lacks are replayed on top in the object store with `git merge-tree`, the way a rebase would, and they still reach GitHub the usual way, since prime-sync never pushes the checkout. A live edit on a path the move changes rides on the move the way asa-tip-sync carries them on the Mac: it is merged onto the new bytes with `git merge-file`, a hunk both sides changed keeps the live side, a file last written before the `main` commit that changed it is that commit's draft and takes the new bytes, and a file that does not merge as text (an untracked file in the way, a binary, a symlink) keeps its bytes as a local edit. The old bytes of each carried or superseded file go to `~/.local/share/prime-sync/carried/<time>-<head>-<target>/` first, and the run's `code` line names every such path. A local commit that conflicts with `main`, a staged edit that differs from both the disk and `main`, a folder in a file's place, or a commit made during the run leaves the checkout as it was, puts a `skipped:` line in `sync.log`, and the next run tries again. A `main` that drops more than 5% of the tracked files since the checkout's base with it, beyond what its commits declare with `Deletes: <n> files on purpose` lines, also leaves the checkout as it was, puts an `alert:` line in `sync.log` and `status.json`, and makes the run exit 1, because 5557c587a deleted every file of `main` on 10-18 and every box's skill links point into the checkout.
2. On a box with an installed runtime (the Mac), it installs `origin/main` as that runtime with `node scripts/install-runtime.mjs --ref <main>` when `main` changed `config/`, `skills/` or `install-manifest.json` since the installed commit, so a rules or skill change reaches the Mac within one run. On 10-20 the Mac read an old `~/.prime/agent/AGENTS.md` until two hand installs (5edd2273, then 537d443b) cleared the d1 parity row. A change to extension code alone does not install, because `main` got 246 such commits in the 24 h before 10-20 01:40Z and each install adds a release. The new release clones the active release's `node_modules` (APFS clone, about 6 s and 15 MB each on the Mac) when its package files match, and runs `npm ci` only when they changed. A runtime on a commit that `main` does not hold stays where the coordinator put it. The same step deletes a release nothing can still read: it is not current, no link in `~/.prime/agent`, no kernel `.pth` pin and no running command line names it, and every `prime-agent` process that hosts sessions started after `history.jsonl` says it was retired. A session spawns helpers such as `send-check.ts` from the release it loaded, so an older session keeps its release. The Prime supervisor (`daemon.sock`) and a `prime-agent --version` probe host no session, so they hold no release; on 10-20 one such probe on the Mac had hung since 16:48Z the day before.
3. It points every home link in `install-manifest.json` at the installed `~/.local/share/sieun-pi-runtime/current` release when present, otherwise at the checkout. This covers skills, `~/.prime/agent/AGENTS.md`, `pstack-models.json` and the two extensions. The installed runtime keeps source and dependencies outside protected folders: on October 20, macOS returned `EPERM` when frontend bro's compiled worker followed its links into Documents, so its image-fitting hook never loaded. Resource links stay unchanged during an installation or when its current release is invalid. A copied folder or file in a managed link's place is deleted, and an obsolete managed skill link is removed.
4. It sets each key of `config/settings.shared.json` in `~/.prime/agent/settings.json`, which keeps the default model, thinking level, retry policy and skills list equal. MCP servers stay per box, because their commands are box paths. A `skills` entry resolves against `~/.prime/agent`, and Prime does not expand `~` after the `-` prefix, so `-../../.agents/skills/find-skills` hides `~/.agents/skills/find-skills` on every box and `-~/.agents/...` hides nothing (checked with a fresh `prime-agent -p --no-session` on us-metal02, 2026-10-18).
5. It merges the global harness entries in `~/.prime/agent/harness/harness_state.json` and the corrections ledger in `~/.prime/agent/browser-chat/corrections.json` with the private repo `sieu-n/prime-shared-state`, writes the result locally and pushes it.

## When the checkout stops following main

1. `blocked.json` in `~/.local/share/prime-sync/` holds the time the checkout stopped following `main`, which is any run whose `code` is not `at`, `pulled`, `rebased` or `ahead of`.
2. After 10 min it finds the Prime session that last wrote each blocking path, from the tool calls in `~/.prime/agent/sessions` and `session-artifacts`, and tells it once with `prime-agent send` to commit the edit or put it back.
3. After 30 min it adds one todo to the AI harness chat's For you list with the chat's `scripts/board-apply.ts`, which forwards it to the chat host, and the first run that follows `main` again checks the todo off.
4. The AI harness chat asked for both on 10-18, after the Mac's checkout sat at 461986e from 08:26Z to 10:45Z with nobody told.

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
2. The timer runs the Python that ran the installer, except on the Mac, where it runs `/opt/homebrew/bin/python3`. macOS refuses a launchd job under `/usr/bin/python3` or the Command Line Tools Python access to `~/Documents`, where the checkout lives, and on 10-18 a reinstall run as `python3 install.py` over ssh stopped the Mac's sync from 08:28Z on that way. A run that cannot read the checkout now reports git's own error, where it used to say the checkout was on a detached HEAD.
3. `~/.config/prime-sync/sync.json` names the checkout, the state repo and its clone, and the agent folder. The host name comes from `~/.config/sieun-pi/hosts.json` when this box is listed there.
4. `sync.log` in the same folder gets one line for each run that changed something or hit an error.
5. The installer copies `gh auth token` into `~/.config/prime-sync/github-token` (mode 0600), and every git call of a run reads GitHub credentials from that file. A launchd job on the Mac cannot open the login keyring that the gh helper uses, and on 10-18 at 03:10Z one run failed its fetch with "Device not configured". Run the installer again after `gh auth login` changes the token.

# sieun-pi

This repository owns the custom Prime Agent setup. Runtime credentials, account stores, logs, session history and learned memories stay outside Git.

Use the root build, check and apply commands. Do not change the live setup from a worker. Only the coordinating session applies it after isolated-profile verification.

The pool runs from an installed copy, not from this checkout. A change under `components/pi-pool` is live only after you commit it and run `/usr/bin/python3 -B components/pi-pool/install.py`; `install.py rollback` undoes the last install. Never edit files under `~/.config/pi-pool` or `~/.local/share/pi-pool`.

Every box runs `components/prime-sync` each minute, which fast-forwards its checkout to GitHub `main` and links skills and `config/AGENTS.md` from it, so a skill or rule edit reaches the other boxes about a minute after it is pushed. Harness entries and the corrections ledger sync through the private repo `sieu-n/prime-shared-state` without a commit here. Install a prime-sync change with `python3 -B components/prime-sync/install.py --ref <sha>` on each box.

Workers own disjoint directories. Do not change another worker's files. Do not commit or push until the coordinator has reviewed the source and secret scan. A push to `main` needs no owner go until the proper launch (c74, 2026-10-15), and a push to `staging` needs no ok (c50).

The live chat on :5182 runs from `~/.local/share/sieun-pi-chat/current`. Release a commit to it only with `node scripts/release-chat.mjs <sha>`, which builds the release folder, takes a lock, refuses a commit older than the live one unless you pass `--rollback`, flips `current` and kickstarts `com.sieun.agent-chat`. `skills/board/references/git.md` has the flags.

Never kill the Prime Agent supervisor (`prime-agent --mode daemon` on `daemon.sock`) or its workers, run `prime-agent shutdown`, or boot out `com.sieun.agent-chat` to free memory or unstick agents. Each one aborts every running turn and archives every live session, and that work waits until someone resumes it. On 10-15 a chat killed the supervisor with `kill -9` three times and a Claude Code session ran `prime-agent shutdown --force` twice, and every agent stopped each time. To free memory, stop only finished or idle sessions (owner rule c88). To restart one stuck agent, run `prime-agent stop <agent>`. A chat release restarts the chat service and leaves the daemon running.

Every limit in sieun-pi and pi-pool is a soft cap, which states its target, flags an overrun and lets the action through (owner rule c98, 2026-10-18). A limit stays hard only when it guards data integrity, security and auth, money, an outside send (c37), a vendor limit or a destructive action on shared state. Each hard limit carries a one-line reason beside it that names which of these it is. pi-pool's account limits and switching rules, such as admission thresholds, slots, move budgets, the turn queue and usage limits, stay hard, and nobody changes them without asking the owner.

Target Prime Agent first. Do not claim upstream Pi compatibility without a separate real runtime check.

Use the repository environment for Python and TypeScript checks. Keep source provenance and third-party notices. Do not publish this repository publicly or to npm without approval.

Several sessions share this checkout and its index. Commit only your own files with `git add -- <new files>` and then `git commit -m "..." -- <your files>`. That commit also updates the shared index for those paths. If you commit through a private index built from HEAD instead, run `git add -- <your files>` on the shared index afterwards, or the shared index keeps the old entries. `npm run develop` sets `core.hooksPath` to `scripts/git-hooks`, whose pre-commit hook refuses a commit that carries stale index entries left behind by another session's private-index commit.

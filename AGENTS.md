# sieun-pi

This repository owns the custom Prime Agent setup. Runtime credentials, account stores, logs, session history and learned memories stay outside Git.

Use the root build, check and apply commands. Do not change the live setup from a worker. Only the coordinating session applies it after isolated-profile verification.

The pool runs from an installed copy, not from this checkout. A change under `components/pi-pool` is live only after you commit it and run `/usr/bin/python3 -B components/pi-pool/install.py`; `install.py rollback` undoes the last install. Never edit files under `~/.config/pi-pool` or `~/.local/share/pi-pool`.

Workers own disjoint directories. Do not change another worker's files. Do not commit or push until the coordinator has reviewed the source and secret scan. A push to `main` needs no owner go while his standing go of c74 (2026-10-15) is on in `components/user-history/src/shared/release-go.ts`; when it is off, run it as `OWNER_OK=<chat id>/<todo id> git push origin main`, where the todo names sieun-pi and the push, or the global-rules merge guard refuses it (c49). A push to `staging` needs no ok (c50).

The live chat on :5182 runs from `~/.local/share/sieun-pi-chat/current`. Release a commit to it only with `node scripts/release-chat.mjs <sha>`, which builds the release folder, takes a lock, refuses a commit older than the live one unless you pass `--rollback`, flips `current` and kickstarts `com.sieun.agent-chat`. `skills/board/references/git.md` has the flags.

Never kill the Prime Agent supervisor (`prime-agent --mode daemon` on `daemon.sock`) or its workers, run `prime-agent shutdown`, or boot out `com.sieun.agent-chat` to free memory or unstick agents. Each one aborts every running turn and archives every live session, and that work waits until someone resumes it. On 10-15 a chat killed the supervisor with `kill -9` three times and a Claude Code session ran `prime-agent shutdown --force` twice, and every agent stopped each time. To free memory, stop only finished or idle sessions (owner rule c88). To restart one stuck agent, run `prime-agent stop <agent>`. A chat release restarts the chat service and leaves the daemon running.

Target Prime Agent first. Do not claim upstream Pi compatibility without a separate real runtime check.

Use the repository environment for Python and TypeScript checks. Keep source provenance and third-party notices. Do not publish this repository publicly or to npm without approval.

Several sessions share this checkout and its index. Commit only your own files with `git add -- <new files>` and then `git commit -m "..." -- <your files>`. That commit also updates the shared index for those paths. If you commit through a private index built from HEAD instead, run `git add -- <your files>` on the shared index afterwards, or the shared index keeps the old entries. `npm run develop` sets `core.hooksPath` to `scripts/git-hooks`, whose pre-commit hook refuses a commit that carries stale index entries left behind by another session's private-index commit.

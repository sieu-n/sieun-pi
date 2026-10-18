# idle-reaper

idle-reaper stops prime-agent workers that sit idle, so their RAM goes back to the Mac.
The daemon keeps a worker alive long after its last turn, and on 10-18 idle workers and hung `--version` processes held the owner's 32 GB Mac near 80% used.
launchd runs it every 5 minutes as `com.sieun.idle-reaper`.

## What one run does

1. It reads `prime-agent sessions --json` from `~/.local/share/prime-agent/bin/prime-agent`, which links to the current release, and the process table from `ps`.
2. It finds the daemon, the `prime-agent --mode daemon` process on `daemon.sock`, and treats each of its direct children on a `worker-*.sock` as a worker.
3. It sends SIGTERM to a worker only when every session on it has `activity` idle, the newest `lastActivityAt` on it is older than 10 minutes, and no session has any of these set: `isBashRunning`, `isRunningTools`, `hasRunningRlmChildren`, `hasActiveHeartbeat`, `hasRegisteredHeartbeat`, `isCompacting`, `isStreaming`, `isSessionActive` or `attachedClients`.
4. It also keeps a worker that started under 2 minutes ago, a worker that no session lists, and a worker with a `bash()` shell still running under its kernels.
5. It kills a `prime-agent --version` child of the daemon once it is older than 2 minutes, with SIGTERM and then SIGKILL after 3 seconds.
6. It reads the sessions and the process table a second time right before it signals, and skips any pid that no longer qualifies.

A killed worker's sessions stay listed in `prime-agent sessions` with `workerState` failed, and the next message to one of them starts a new worker (checked by hand on 10-18).
The reaper never signals the daemon, a busy worker, or a `prime-agent` TUI on a tty, because those abort running turns (AGENTS.md, owner rule c88).

## Files

1. `~/.local/share/idle-reaper/reaper.py` is the installed copy that launchd runs.
2. `~/.local/share/idle-reaper/reaper.log` gets one line per kill with the pid, MB (the process and its child processes), age and session names, plus one line per failed run.
3. `~/.local/share/idle-reaper/status.json` holds the last run's plan, with the reason each kept worker stayed.
4. `~/.local/share/idle-reaper/last-run.txt` holds the last run's printed output.

## Install, check and turn off

```sh
/usr/bin/python3 -B components/idle-reaper/reaper.py --dry-run          # print what it would kill, signal nothing
/usr/bin/python3 -B components/idle-reaper/install.py --ref "$(git rev-parse HEAD)"
tail ~/.local/share/idle-reaper/reaper.log
touch ~/.local/share/idle-reaper/disabled                               # pause it; rm the file to resume
/usr/bin/python3 -B components/idle-reaper/install.py uninstall         # remove the launchd agent
```

`--idle-minutes` and `--version-minutes` change the two thresholds for a manual run.
`tests/test_idle_reaper.py` checks which workers the plan picks.

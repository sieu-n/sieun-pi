# watchdog

The watchdog finds Prime Agent sessions that stopped making progress and recovers them. One cycle runs every 10 minutes from `prime-agent-watchdog.timer`, outside every agent session, so a wedged session cannot stop its own recovery.

## Files

| File | What it holds |
| --- | --- |
| `cron_cycle.py` | The timer's entry point: it re-applies the kernel revive guard, runs one cycle and appends one line to `cron.jsonl`. |
| `watchdog.py` | The session snapshot, the verdicts in `classify`, the recoveries in `nudge` and the cycle. |
| `wd_probe.py` | The model probe, which asks a throwaway session for one word when a whole model cohort is silent. |
| `wd_procs.py` | Process readings from one `ps` table and per-pid `lsof`, swap and load, and the parked shells that wedge a tool call. |
| `wd_daemon.py` | The daemon socket client that clears a phantom turn, and the tmux drivers of the interactive UI. |
| `wd_heartbeats.py` | The re-arm of rlm heartbeats that a killed session close cancelled. |
| `repl_guard.py` | It re-applies `repl-guard.patch` or `repl-guard-pre-mem.patch` (prime-agent#3447) after a Prime update rewrites `rlm/repl.py`. |
| `fleet_triage.py` | A read-only triage table of every live session, used by the Mac's 30-minute heartbeat. |

## The model probe

1. When every live session of one model is silent, the cycle starts `prime-agent --mode rpc --model <m> --no-session --no-tools` and asks for "pong", with a 100 s limit.
2. The answer is `alive`, `stalled` or `pool_wait`. A probe reads as `pool_wait` when pi-pool's slot-wait text ("this session waits for its slot at ...") shows up in its stream, or when `pi-pool.log` has a `wait` or `parked` row for the probe's session id, which the probe reads with the rpc `get_state` command.
3. A frozen session of a `stalled` model gets the verdict `MODEL_STALL`, and one of a `pool_wait` model gets `POOL_WAIT`. Neither is touched, and each probe writes one `model_probe` line to `log.jsonl`.
4. The probe ends its turn with the rpc `abort` command and then closes its stdin, so the supervisor logs no failed command. A probe that is still running 15 s later gets SIGTERM and then SIGKILL sent to its own process group, which it got from `start_new_session`.
5. The old probe ran `prime-agent -p` and, after 100 s, `pkill -f 'prime-agent -p --model <m>'`. On 10-18 pi-pool held it in a slot wait, the kill made the supervisor log "prompt_and_wait failed: Daemon worker client closed" at 12:44:48Z and 12:54:46Z, which made dirty minutes in the Whole system precheck, and at 13:14:22Z the pattern also killed a pong probe another agent ran by hand.

## Archived chats

1. A cycle never wakes a session whose chat the owner archived (`archived-chats.json`) or a clean-room test chat (`clean-room-chats.json`). Its verdict is `ARCHIVED`, and `fleet_triage.py --apply` skips the same sessions. An archived `session_state` in the file is no reason, because the daemon's eviction and the Mac copy write it too.
2. Both files come from the chat service's data folder, `$AGENT_CHAT_DATA_DIR` or `~/.prime/agent/browser-chat`. A subagent counts by the root of its session-artifacts tree.
3. On 10-18 a cycle sent plan-and-duties run-1's test chat "Your last turn was dropped" at 14:34:58Z, 6.8 min after its teardown archived it, and the chat went on working into run-2. `tests/test_archived.py` replays that case.

## Install

```sh
python3 -B components/watchdog/install.py --ref "$(git rev-parse HEAD)"
python3 -B components/watchdog/install.py rollback
```

1. The installer copies the `.py` and `.patch` files of the commit to `~/.local/share/prime-watchdog/releases/<sha>` and points `current` at that folder in one rename, so a later checkout change cannot alter the running code.
2. It writes `prime-agent-watchdog.service` and `prime-agent-watchdog.timer` into `~/.config/systemd/user` and enables the timer. The next timer run uses the new code, and nothing running is stopped.
3. The state and logs stay in `~/.prime/agent/watchdog`: `state.json`, `log.jsonl`, `heartbeats.json`, `cron.jsonl`, `cron.out.log`, `cron.err.log`, `cycle.lock` and `repl_guard_state.json`. Each code file name in that folder becomes a link into `current`, and the old `.bak` copies, tests and `run_cycle.py` are deleted.
4. The installer runs on Linux only. The Mac ran its own copy under launchd (`com.sieun.prime-agent-watchdog`), which this installer does not touch.

## Tests

```sh
python3 -B -m unittest discover -s components/watchdog/tests
WATCHDOG_DIR=<folder with an old watchdog.py> python3 -B -m unittest components/watchdog/tests/test_probe.py
```

The second line runs the probe cases against an old `model_alive()`, where the 12:44Z, 12:54Z and 13:14Z cases fail.

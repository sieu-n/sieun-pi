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
2. The answer is `alive`, `stalled` or `pool_wait`. A probe reads as `pool_wait` when pi-pool's slot-wait text ("this session waits for its slot at ...") shows up in its stream, or when `pi-pool.log` has a `wait` or `parked` row for the probe's session id, which the probe reads with the rpc `get_state` command. It also reads as `pool_wait` when Prime reports pi-pool's turn queue with a `wait_status_changed` event ("a turn, place 91 of 91") and no pong came. From 10-23 08:00Z to 10-24 08:50Z all 279 probes on us-metal02 read `stalled` while they sat in that queue.
3. A frozen turn (`FROZEN_TURN`, `PHANTOM_TURN`) of a `stalled` model gets the verdict `MODEL_STALL`, and one of a `pool_wait` model gets `POOL_WAIT`. Neither is touched, and each probe writes one `model_probe` line to `log.jsonl`. A tool verdict (`FROZEN_TOOL`, `STUCK_TOOL`) waits on a process, so the probe leaves it as it is.
4. The probe ends its turn with the rpc `abort` command and then closes its stdin, so the supervisor logs no failed command. A probe that is still running 15 s later gets SIGTERM and then SIGKILL sent to its own process group, which it got from `start_new_session`.
5. The old probe ran `prime-agent -p` and, after 100 s, `pkill -f 'prime-agent -p --model <m>'`. On 10-18 pi-pool held it in a slot wait, the kill made the supervisor log "prompt_and_wait failed: Daemon worker client closed" at 12:44:48Z and 12:54:46Z, which made dirty minutes in the Whole system precheck, and at 13:14:22Z the pattern also killed a pong probe another agent ran by hand.

## Pressure targets and stalled subagent tools

1. A cycle wakes at most 5 sessions (`MAX_RESUMES_PER_CYCLE`), and that budget is the only gate on its recoveries.
2. Swap above 16 GiB and a 1-minute load above 30 are soft targets under owner rule c98. An action over either one goes through, and the cycle writes one `over` line per target to `log.jsonl`.
3. As hard gates they stopped every recovery on us-metal02, where 14,649 actions were skipped from 10-19 16:53Z to 10-24 08:46Z at 16 to 80 GiB swap used, while 132 GiB RAM sat free and the load sat near 200 on 80 cores.
4. A subagent shares its parent's worker, so the cycle finds its own tools under the RLM kernel whose `RLM_HARNESS_STATE_DIR` names its session id.
5. When a subagent has been silent 45 minutes while one of those tools burns CPU, the parent's `CHILD_WEDGED` notice names the pid, the command and its CPU minutes. On 10-24 a `git grep -w -F -f` with 1,117 patterns and a `reach.py` stuck in a regex burned 2.7 and 0.95 cores for over an hour under two code cut 3 subagents. `tests/test_stalled_tools.py` covers both parts.
6. Right before a `CHILD_WEDGED` notice goes out, the cycle reads the subagent again and sends nothing when it has a pending `board.wake` file in `browser-chat/wakes/`, a run in pi-pool's turn queue (`turns.json` `queued` or `kept`), or an `agent_message.send` to its parent after its last prompt. The verdict turns `OK` and the cycle writes one `child_waits` line to `log.jsonl`. On 10-24 at 19:35:33Z a cycle told the AI harness chat to cancel checkin pushes goals, which sat 105th in that queue, held a wake for 10:40Z on 10-25 and had reported to its parent at 19:33:50Z. `tests/test_waiting_child.py` replays that case.
7. That second read also counts the subagent's silence from the later of its last output and the pi-pool slot it holds now (`turns.json` `working`), so a subagent that got its slot or wrote output after the cycle read it gets no notice. On 10-27 a cycle read pi cutover prep at 19:08:57Z, silent 51.7 min while its parent's message sat 136th in that queue, and sent the AI harness chat "Cancel that child" at 19:15:31Z, after pi-pool had admitted the child at 19:14:37Z and it had written 7 tool calls. `tests/test_waiting_child.py` replays that case too.

## Archived chats

1. A cycle never wakes a session whose chat the owner archived (`archived-chats.json`) or a clean-room test chat (`clean-room-chats.json`). Its verdict is `ARCHIVED`, and `fleet_triage.py --apply` skips the same sessions. An archived `session_state` in the file is no reason, because the daemon's eviction and the Mac copy write it too.
2. Both files come from the chat service's data folder, `$AGENT_CHAT_DATA_DIR` or `~/.prime/agent/browser-chat`. A subagent counts by the root of its session-artifacts tree.
3. On 10-18 a cycle sent plan-and-duties run-1's test chat "Your last turn was dropped" at 14:34:58Z, 6.8 min after its teardown archived it, and the chat went on working into run-2. `tests/test_archived.py` replays that case.

## Answered turns

1. A session owes an answer from the first input that no turn has answered yet, and `owed_since` in the cycle's record is that input's time.
2. An input is a user message, a tool result or a custom message that wakes the agent (`PROMPT_TYPES`, from `turns.ts` in `components/user-history/src/shared`), and other custom messages, such as the correction refine's notes, owe nothing.
3. A turn answers its inputs when the assistant said something, or when it ended with stopReason `stop` and no owner message was among them, so a chat may end a turn on an agent message, a check-in or a notice with no words.
4. An owner message stays owed until the chat replies in text or through `tell_owner`, and a turn cut by an error, an abort, the length limit or a worker death leaves its inputs owed.
5. A user message counts as the owner's unless it opens with a chat service note prefix (`SERVER_NOTES` in `components/user-history/src/shared/chat-feed.ts`), a Prime tag or `[watchdog]`, and `tests/test_silent_turn.py` checks both Python lists against those files.
6. One owed input gets one resume notice, because each `resume_queue + send` line in `log.jsonl` holds its `owed_since`, and a later cycle reads that input as `NOTICED`. A failed send is tried once more after 5 s and then counts, because on the Mac from 10-20 to 10-22 five sessions got 1011 notices whose sends all failed with "Unknown active session", and those retries took the cycle's resume budget.
7. On 10-21 the Mac's watchdog woke gpt sol at 20:08Z, 20:43Z, 21:19Z and 22:18Z with "the input was never answered", because each of its silent turn ends on a non-owner notice read as a dropped turn, and each wake ended silent again. On 10-22 the box's watchdog woke gpt sol (metal 02) at 01:47:55Z after it had answered its owner, because the correction refine's notes read as owed input.

## Gone trees and the outbox

1. A job whose tree is gone reads `ARCHIVED` and takes none of the cycle's budget: a record says it or a job above it was deleted or cancelled on purpose (`stop_record` in `resume_paused.py`), or its tree's root is archived or unlisted on its daemon and is no chat or thread of the chat service.
2. The chat service's records (`archived-chats.json`, `clean-room-chats.json`, `chats.json`, `threads.json` and the stop records) come from the chat host of hosts.json, through `resume_paused.py`'s `chat_file_text`, because the Mac's own copies stopped on 10-18 when the chat moved to us-metal02.
3. When the daemon refuses a notice for its session uuid ("Unknown active session"), the cycle hands it to the chat service's agent outbox (`api/agent/notice`), which relays it to the parent of a subagent with no worker or opens a root from its file.
4. From 10-20 to 10-22 the Mac sent 1291 notices, 1203 of them to uuids the daemon refused, and 1011 to five jobs whose trees were gone: box-takeover, douyin duty box sync, vite-mem, discover page errors and limits-flagged-10-16.

## Finished work

1. A dropped turn of a job a chat lists (`api/threads/<chat>/agents`) gets a wake only while its work is owed: an open step of the chat's board names it, the chat shows it working, or an owner message to it has no reply.
2. Otherwise it reads `WORK_DONE`, and the cycle writes one `"skip": "work_done"` line with the input's `owed_since` to `log.jsonl`, so later cycles read it as `NOTICED`.
3. A job's brief is no owner message: a subagent's task opens with `[task from parent]`, and a chat brief opens with "Owner's words:".
4. A chat list or board that does not answer never reads work as done.
5. On 10-22 the Mac's cycles at 03:11Z and 03:22Z woke ten jobs whose turns dropped on 10-15, among them duties green fleet and checkin stuck_steps fix, and each found its work finished; 21 of the Mac's 71 wakes that day were of this kind.

## Daemon reads

1. A `list` or a plain `send` goes through sieun-pi's daemon reader (`components/user-history/src/daemon-cli.mjs` in the installed runtime or chat release), which waits 30 s for the daemon's hello and opens the daemon once more after a failed hello.
2. Every other command, and every command on a box without the reader, runs the prime-agent CLI and runs once more when the hello missed the CLI's fixed 3 s, since nothing was done then.
3. On 10-22 65 of 108 probes on us-metal02 got the hello after 3 to 7 s, and at 04:42Z `prime-agent list` failed so twice; the reader's list took 17 s at that load and answered.

## Install

```sh
python3 -B components/watchdog/install.py --ref "$(git rev-parse HEAD)"
python3 -B components/watchdog/install.py rollback
```

1. The installer copies the `.py` and `.patch` files of the commit to `~/.local/share/prime-watchdog/releases/<sha>` and points `current` at that folder in one rename, so a later checkout change cannot alter the running code.
2. On Linux it writes `prime-agent-watchdog.service` and `prime-agent-watchdog.timer` into `~/.config/systemd/user` and enables the timer. The next timer run uses the new code, and nothing running is stopped.
3. The state and logs stay in `~/.prime/agent/watchdog`: `state.json`, `log.jsonl`, `heartbeats.json`, `cron.jsonl`, `cron.out.log`, `cron.err.log`, `cycle.lock` and `repl_guard_state.json`. Each code file name in that folder becomes a link into `current`, and the old `.bak` copies, tests and `run_cycle.py` are deleted.
4. On the Mac the installer writes no units, because launchd's `com.sieun.prime-agent-watchdog` already runs `~/.prime/agent/watchdog/cron_cycle.py` with `/usr/bin/python3`, and that name becomes a link into `current` too. Run the same two commands from the Mac's checkout, `~/Documents/Github/sieun-pi`.

## Tests

```sh
python3 -B -m unittest discover -s components/watchdog/tests
WATCHDOG_DIR=<folder with an old watchdog.py> python3 -B -m unittest components/watchdog/tests/test_probe.py
```

The second line runs the probe cases against an old `model_alive()`, where the 12:44Z, 12:54Z and 13:14Z cases fail.

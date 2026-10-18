---
name: resume-paused-sessions
description: "Use when a network drop, sleep, or restart stopped Prime runs. Finds the interrupted runs and sends \"continue\" to each head session."
---

# Resume paused sessions

An interrupted run sits `idle` and looks finished. Only a heartbeat or a message restarts it.

Resume the head session only. The head gets `continue` plus the list of its stopped runs, and it re-drives its children. Do not message the children too, because they would then work in parallel with a head that does not know they restarted.

## Run the script

```
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py --dry-run
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py
```

The script reads `prime-agent list --json` and the tail of each live session file. It counts a run as interrupted in these cases:

- The last message is an assistant error that names a network, sign-in, rate limit (429), overloaded (529), 5xx or refusal failure.
- The last message is a tool result, user message or tool call with no reply, and it is more than 2 minutes old.
- The last message is an empty model reply that asked for a tool.
- The run shows `working` but did nothing for 30 minutes, or for 120 minutes inside one tool call.

It leaves a run stopped, and does not list it, when its tool call ends on "Request was aborted" with no archive and no update notice in that turn. That abort has no recorded cause either, and an Esc abort writes the same line. It lists a run as `daemon_restart` when a daemon restart aborted its turn with no archive, or when `prime-agent update` stopped the turn, even when the turn ran more steps after the update's notice. An archive that stopped the last turn decides the run by the reason on the archive line and by the records around it. A Prime older than stop-provenance writes the line with no reason, and then an owner Stop, a kill, the idle unload and an update discard all write the same line:

1. A recorded stop keeps the run stopped and lists it under `stopped` with the record. The records are the chat's deleted-jobs.json, the owner's archived-chats.json, a delete op for the job's folder or a folder above it in the RLM ledger (`~/.prime/agent/rlm-ledger/<16 hex>.jsonl`), and `"status": "deleted"` in the job's rlm-subagent.json. A ledger or registry delete counts only for the turn it stopped, so a user message after the delete, or a ledger spawn after it, means the run was reopened.
2. A stop reason on the archive line keeps the run stopped the same way: owner_stop, owner_archive, subagent_deleted, subagent_cancelled, completed, replaced, spawn_failed and draft_discarded.
3. The idle unload's archive, by its idle_unload reason or by its record (`~/.prime/agent/browser-chat/unloaded.json`) for a line with no reason, is resumed only after a token hook failure. Any other run it stopped is listed under `stopped`.
4. Every other archive is listed under `unresolved` with its cause and gets no message, even inside a restart window. That covers a line with no reason and no record, daemon_shutdown, a reason the script does not know, and update_discarded. An update discard names its cause when the update's record in `~/.prime/agent/update-restarts/` lists the session within 5 s before the archive, and an empty_draft or no_session_file discard counts as stopped. A line with no reason that the update's `stoppedBeforeRestore` names at the same time stays unresolved, even when the unload's record follows it.

Only the archive that stopped the last turn counts, so an older archive from before a reopen decides nothing. Each send reads the stop records and the run's transcript again right before it goes, so a run deleted after the pass found it, or archived later with a stop reason, gets nothing and no record. A missing record file counts as empty, and so does an rlm-subagent.json the relay answers 404 "no such file" for. A record that cannot be read or parsed is reported under `incomplete`, and the runs it covers get nothing, and so is a ledger line that is not a v1 record. The ledger's last line counts only once it ends in a newline. Another box's ledger and update records are not read through the relay, so there only rlm-subagent.json shows a delete. It also skips runs older than `--since-minutes` (default 1440), runs whose head got a user message after the stop, and runs it already resumed. It records resumed runs in `~/.prime/agent/resume-paused-sessions.json`. It also holds back a run until `pi-pool who` names an account that can serve its tree, because an earlier resume fails again at once. A run that stopped on a token hook failure is held back instead until the hook, run once for its tree the way Prime runs it, gives a token, and the token is dropped unread.

The script also looks at every other box in `~/.config/sieun-pi/hosts.json`: it lists and messages that box's daemon through `sieun-pi hosts daemon <host> list|send` and reads its session files and daemon logs through the box's relay (`GET /v1/file`, the tail by Range). So the pass the chat service runs on the chat host covers the jobs of every box. `--this-box` keeps it to the local daemon.

Each run maps to its head through `parentActiveSessionId`. An idle head gets the message plus the list of stopped runs below it. A working head gets the list as a steer note. A working head with no stopped children is skipped.

The other flags are `--message`, `--since-minutes 0` for no age limit, `--include-children` (use it only when the user asks), `--state` and `--json`.

When a SIGTERM stops the script, for example when systemd stops the chat service's unit, it still prints the report of the boxes it finished, names each box it did not finish and the step it was on under `incomplete`, and exits 143. A send that is running when the signal comes finishes and is recorded first. Another box that answers with an error or a malformed list goes under `incomplete` too, and the other boxes still run. The chat service lets a pass run to its end and logs a warning once it takes over 90 s.

## Hung runs and dead workers

A message cannot reach a hung run. Abort it first, then pass its full session id with `--unstuck <id,id>`. The sieun-pi chat Resume button does both steps (`components/user-history/src/chat-resume.ts`).

A run whose Prime worker died shows `workerState` `failed` in `prime-agent list --json`. It takes no abort, stop or message, and each one answers "Session worker is failed". The script lists it as `worker_failed` and skips any head whose own worker died. Reopen that head from its saved file with a daemon `create` that passes its `sessionPath`, then run the script again. The daemon drops the dead worker and starts the head on a new one. The chat Resume button and a pinned chat both do the reopen.

## Stopped subagents

The daemon finds a subagent only while its tree's worker holds it. After the chat service's idle unload or a restart drops one, `prime-agent send <id>` answers "Unknown active session". To resume such a subagent, name its full session id:

```
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py --direct --only <session id>
```

The script reads the subagent from its file under `~/.prime/agent/session-artifacts/<root>/sub-*/`, even when an archive or abort came before its cut turn. The send to it fails, so the script sends its parent a `[relay]` note with the subagent's name, id and last step. The note asks the parent to pass the message on with `agent_message.send(..., receiver_role="child", receiver_name=<name>)`, and that call reopens the subagent in the parent's tree. A parent the daemon does not hold either gets the note through its own parent. The result shows `relayed_through` with the parent's id. The chat service's wakes, brief keeper and alert bridge send the same way (`components/user-history/src/subagent-relay.ts`).

## Verify

After 30 to 60 seconds, run `prime-agent list` and check that the heads and their children show `working`. Run the script with `--dry-run` again to see what is still interrupted.

## Manual fallback

`agent_message` cannot reach sessions outside your own family, so use the CLI:

```
prime-agent list --json                       # sessions, sessionFile, parentActiveSessionId
prime-agent send --json <12-char-id> continue # deliveryStatus: delivered, deliveryMode: steer
```

The 12-char id is the last 12 characters of the session UUID. Do not send `continue` to a run whose last message ended with `stopReason: "stop"` or `aborted`. Do not send it to a run that failed on a 400 request error or stopped days ago.


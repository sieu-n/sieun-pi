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

It skips runs that were aborted or archived, unless the abort or archive came from a daemon restart (it reads each supervisor restart from the daemon logs and lists such runs as `daemon_restart`) or from the chat service's idle unload (`~/.prime/agent/browser-chat/unloaded.json`, read from the session file when the daemon no longer lists it). It also skips runs older than `--since-minutes` (default 1440), runs whose head got a user message after the stop, and runs it already resumed. It records resumed runs in `~/.prime/agent/resume-paused-sessions.json`. It also holds back a run until `pi-pool who` names an account that can serve its tree, because an earlier resume fails again at once. A run that stopped on a token hook failure is held back instead until the hook, run once for its tree the way Prime runs it, gives a token, and the token is dropped unread.

Each run maps to its head through `parentActiveSessionId`. An idle head gets the message plus the list of stopped runs below it. A working head gets the list as a steer note. A working head with no stopped children is skipped.

The other flags are `--message`, `--since-minutes 0` for no age limit, `--include-children` (use it only when the user asks), `--state` and `--json`.

## Hung runs and dead workers

A message cannot reach a hung run. Abort it first, then pass its full session id with `--unstuck <id,id>`. The sieun-pi chat Resume button does both steps (`components/user-history/src/chat-resume.ts`).

A run whose Prime worker died shows `workerState` `failed` in `prime-agent list --json`. It takes no abort, stop or message, and each one answers "Session worker is failed". The script lists it as `worker_failed` and skips any head whose own worker died. Reopen that head from its saved file with a daemon `create` that passes its `sessionPath`, then run the script again. The daemon drops the dead worker and starts the head on a new one. The chat Resume button and a pinned chat both do the reopen.

## Verify

After 30 to 60 seconds, run `prime-agent list` and check that the heads and their children show `working`. Run the script with `--dry-run` again to see what is still interrupted.

## Manual fallback

`agent_message` cannot reach sessions outside your own family, so use the CLI:

```
prime-agent list --json                       # sessions, sessionFile, parentActiveSessionId
prime-agent send --json <12-char-id> continue # deliveryStatus: delivered, deliveryMode: steer
```

The 12-char id is the last 12 characters of the session UUID. Do not send `continue` to a run whose last message ended with `stopReason: "stop"` or `aborted`. Do not send it to a run that failed on a 400 request error or stopped days ago.

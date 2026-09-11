---
name: resume-paused-sessions
description: Resume Prime Agent sessions that stopped on a network error (wifi drop, "Connection error.", fetch failed). Finds every live session whose last message ended in a network error, maps each to its head (root top-level) session, and sends "continue" to the idle heads only; the heads re-drive their children. Use when the user says "wifi is back", "restart paused sessions", "resume the head session", "say continue to the stuck sessions", or after any network outage.
---

# Resume paused sessions

A network drop makes running sessions end their turn with `stopReason: "error"` and `errorMessage: "Connection error."`. They then sit `idle` and look finished. Nothing restarts them on its own except sessions with an active heartbeat.

User rule (2026-09-03): resume only the head session. Do not message every errored child. The head gets `continue`, checks its children, and re-drives them. Messaging children too makes them work in parallel with a head that does not know they restarted.

## Do this

```
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py --dry-run
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py
```

The script:

1. Runs `prime-agent list --json`.
2. Reads the tail of each live session's `sessionFile` and keeps the last entry of `type == "message"`. A session is paused when that entry has `stopReason == "error"` and a network-type `errorMessage`, within `--since-minutes` (default 180).
3. Walks `parentActiveSessionId` up to the root. That root is the head.
4. Sends `prime-agent send --json <head> continue` to each head that is not already `working`. Heads that are already working are listed as skipped.
5. Prints the paused sessions, the heads, and each delivery status.

Options: `--message`, `--since-minutes 0` (no age limit), `--include-children` (message errored children too; only when the user asks), `--json`.

## Verify

Run `prime-agent list` again after 30 to 60 seconds. The heads and their children should show `working`. The session file's newest `message` entry should no longer be an error. The script does not wait; run it again with `--dry-run` to see what is still paused.

## Do not

- Do not send `continue` to sessions whose last message is a normal `stopReason: "stop"`. They finished a turn and wait for input. They are not paused.
- Do not resume old errors. An error from days ago is a dead session, not a paused one. The default 180-minute window filters these.
- Do not use `agent_message` or `agent_observe` from a fresh root session for this. They only reach parent, siblings, and direct children. The `prime-agent send` CLI reaches any session by id.

## Manual fallback

```
prime-agent list --json                       # sessions, sessionFile, parentActiveSessionId
prime-agent send --json <12-char-id> continue # deliveryStatus: delivered, deliveryMode: steer
```

The 12-char id in `prime-agent list` is the last 12 characters of the session UUID.

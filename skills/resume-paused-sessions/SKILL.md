---
name: resume-paused-sessions
description: Resume Prime Agent runs that an interruption stopped (wifi drop, "Connection error.", fetch failed, a Mac that slept or shut down, a sign-in token that could not refresh offline). Finds every live run that is interrupted, maps each to its head (root top-level) session, and sends "continue" to the idle heads only; the heads re-drive their children. Use when the user says "wifi is back", "restart paused sessions", "continue the runs that died", "resume the head session", "say continue to the stuck sessions", or after any network outage or restart. The sieun-pi chat sidebar runs the same script behind its "N interrupted / Resume" button.
---

# Resume paused sessions

A network drop makes running sessions end their turn with `stopReason: "error"` and an error such as `Connection error.`. A Mac that sleeps can also fail the token refresh (`Failed to resolve API key ... pi-pool-token`). A shutdown can cut a turn off after a tool call with no reply. Each of these sessions then sits `idle` and looks finished. The daemon retries a network error a few times on its own; after that, nothing restarts the run except a heartbeat or a message.

User rule (2026-09-03): resume only the head session. Do not message every interrupted child. The head gets `continue` plus the list of its stopped runs, checks its children, and re-drives them. Messaging children too makes them work in parallel with a head that does not know they restarted.

## Do this

```
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py --dry-run
python3 ~/.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py
```

The script:

1. Runs `prime-agent list --json` (it also finds `~/.local/share/prime-agent/bin/prime-agent` when `prime-agent` is not on `PATH`, or uses `PRIME_AGENT_BIN`).
2. For each live, idle session active in the window (`--since-minutes`, default 1440 = 24 h), reads the tail of `sessionFile` and takes the last `type == "message"` entry. The run is interrupted when that entry is an assistant error whose text names a network or sign-in failure, or when it is a tool result, user message or tool call with no reply (older than 2 minutes).
3. Drops a run when its head got a user message after the interruption, or when this script already resumed it. The script records resumed runs by full session id in `~/.prime/agent/resume-paused-sessions.json`. Rate limits (429), overloaded (529) and 5xx errors also count. Every run waits until `pi-pool who` says the account its tree's next request gets can serve; resuming earlier fails again at once. The pool extension records each 429 (`pi-pool limited`), so `who` skips the limited account until its reset.
4. Walks `parentActiveSessionId` up to the root. That root is the head.
5. Sends each idle head `continue`, followed by the list of stopped runs below it. A working head gets the list as a steer note. A working head with no stopped children is skipped.
6. Prints the interrupted runs, the heads, and each delivery status.

Options: `--message`, `--since-minutes 0` (no age limit), `--include-children` (message interrupted children too; only when the user asks), `--json`, `--state`.

## Button in the sieun-pi chat

The chat sidebar shows "N interrupted" with a Resume button when the script finds interrupted runs. It checks every 60 seconds, on window focus and when the browser comes back online. `GET api/interrupted` runs the script with `--dry-run`; `POST api/interrupted` runs it for real. The code is `components/user-history/src/chat-resume.ts` and `src/client/InterruptedRuns.svelte`.

## Verify

Run `prime-agent list` again after 30 to 60 seconds. The heads and their children should show `working`. Run the script again with `--dry-run` to see what is still interrupted.

## Do not

- Do not send `continue` to sessions whose last message is a normal `stopReason: "stop"`, or `aborted` (the user pressed stop). They are not interrupted.
- Do not resume errors that are not interruptions, such as 400 request errors. A 429 or usage-limit stop is the exception in step 3: it is resumed, but only once `pi-pool who` names an account that can serve.
- Do not resume old errors. A run that stopped days ago is dead. The 24-hour window filters these.
- Do not use `agent_message` or `agent_observe` from a fresh root session for this. They only reach parent, siblings, and direct children. The `prime-agent send` CLI reaches any session by id.

## Manual fallback

```
prime-agent list --json                       # sessions, sessionFile, parentActiveSessionId
prime-agent send --json <12-char-id> continue # deliveryStatus: delivered, deliveryMode: steer
```

The 12-char id in `prime-agent list` is the last 12 characters of the session UUID.

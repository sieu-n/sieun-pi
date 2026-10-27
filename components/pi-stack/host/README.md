# pi-host

pi-host holds many Pi `AgentSessionRuntime`s in one Node process.
It serves them over a unix socket that speaks the part of Prime's v7 daemon protocol that sieun-pi calls, and through an in-process API on `globalThis`.
Nothing here is live.

## Start it

```sh
cd components/pi-stack
node --import tsx host/src/main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--data-dir <dir>] [--extension <path>]... [--extensions-file <path>] [--no-default-extensions] [--cwd <dir>] [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat]
```

1. Every session loads the extensions in `host/extensions.json`, with paths relative to that file, then each `--extension`, which repeats. `--extensions-file` names another list, and `--no-default-extensions` skips it.
2. `--model` is the model a session gets when its create names none.
3. `--idle-unload-min` unloads a session that is idle with no client attached, 30 by default and 0 for never.
4. `--scratch-chat` adds `replay: true` to the hello, so a scratch chat serve with `--scratch --replay-daemon` passes its writes through.
5. SIGTERM disposes every session, releases every lease, removes the socket and exits 0.

`pi-host.service.template` is a systemd user unit for later, and nothing enables it.

## Files

| File | What it holds |
|---|---|
| `src/protocol.ts` | The v7 subset: commands, responses, events, `SessionSummary` and the hello. |
| `src/api.ts` | `HostApi` and `hostApi()`, the in-process API that pi-agent-bus and the step 6 scheduler call. |
| `src/host.ts` | `PiHost`: open, lazy restore, kill, idle unload, delivery and the command handlers. |
| `src/session.ts` | `HostedSession`: one runtime with its event cursor, replay buffer and attached clients. |
| `src/lease.ts` | The lease map and lockfile, plus `leaseExtension` for a plain `pi` CLI. |
| `src/server.ts` | The socket. |
| `src/guard.ts` | The `uncaughtException` and `unhandledRejection` guard from research probe P6. |
| `src/client.ts` | A small socket client for tests and scripts. |
| `src/main.ts` | The CLI. |
| `src/schedule.ts` | Prime's schedule grammar, job record, `/heartbeat` arguments and deferral rule. |
| `src/scheduler.ts` | `Scheduler`: the jobs file, the clock, claims and delivery. |
| `src/scheduler-extension.ts` | The per-session side: the scheduler handle, `rlm_heartbeat.*`, `/heartbeat` and the skill path. |
| `skills/rlm-heartbeat` | Prime's `rlm_heartbeat` Python skill, unchanged. |
| `probes/scale.ts` | Opens copies of real sessions in one host, streams several against `probes/mock-openai.mjs`, and records RSS and event-loop delay. |

## Rules it keeps

1. A session's Pi session id is also its v7 `activeSessionId`.
2. Opening a session takes a lease on the file's real path and writes `<file>.lock`, so a second writer in the host or in another process gets refused.
3. `kill` and idle unload leave the file and a dormant row in `shared/registry.ts`, and any later command or delivery reopens the session.
4. A command outside `HOST_COMMANDS` fails with `Unknown daemon command: <type>`.

## Scheduler

`src/scheduler.ts` keeps Prime's heartbeats, RLM heartbeats and cron prompts in `<data dir>/scheduled-jobs.json`, where the data dir is `--data-dir` or `<agent dir>/pi-host`.
Each job has Prime's `AgentCronJob` fields, so `cron_list`, `heartbeats_list`, `heartbeat_get`, `heartbeat_set`, `heartbeat_update`, `heartbeat_manage`, `cron_add` and `cron_cancel` answer what the chat parses, and a change to the heartbeat catalog sends `heartbeats_changed` to every client.

1. The clock fires with no client attached, and a due job whose session is unloaded makes the host reopen it from its file, or open its root first for a pi-rlm child.
2. A tick is claimed on disk before it is delivered, so a host that dies mid-delivery records the tick as interrupted at its next start and does not replay it.
3. Ticks missed while the host was down come due once, and the schedule continues from that run.
4. A heartbeat lands as Prime's `heartbeat_prompt` custom message, `[heartbeat: <schedule> run#<n>]`, which starts a turn in an idle session and steers a busy one, or waits for a `follow_up` heartbeat.
5. A heartbeat skips its tick while the session compacts, retries or holds queued input, and a `follow_up` heartbeat also skips while the session streams.
6. `kill` cancels the session's jobs and its children's, as Prime's does, while idle unload and shutdown keep them.

`src/scheduler-extension.ts` loads into every session and every pi-rlm child. It attaches the session to the scheduler, answers the kernel's `rlm_heartbeat.*` requests, registers `/heartbeat` and lists the `rlm-heartbeat` skill from `skills/`.
`src/schedule.ts` holds the schedule grammar, ported from Prime's MIT `cron-jobs.js` as `PROVENANCE.md` records.

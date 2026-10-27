# pi-host

pi-host holds many Pi `AgentSessionRuntime`s in one Node process.
It serves them over a unix socket that speaks the part of Prime's v7 daemon protocol that sieun-pi calls, and through an in-process API on `globalThis`.
Nothing here is live.

## Start it

```sh
cd components/pi-stack
node --import tsx host/src/main.ts --socket <path> --agent-dir <dir> [--session-dir <dir>] [--extension <path>]... [--cwd <dir>] [--model <provider/id>] [--idle-unload-min <n>] [--scratch-chat]
```

1. `--extension` repeats, and every session loads each one.
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
| `probes/scale.ts` | Opens copies of real sessions in one host, streams several against `probes/mock-openai.mjs`, and records RSS and event-loop delay. |

## Rules it keeps

1. A session's Pi session id is also its v7 `activeSessionId`.
2. Opening a session takes a lease on the file's real path and writes `<file>.lock`, so a second writer in the host or in another process gets refused.
3. `kill` and idle unload leave the file and a dormant row in `shared/registry.ts`, and any later command or delivery reopens the session.
4. A command outside `HOST_COMMANDS` fails with `Unknown daemon command: <type>`.

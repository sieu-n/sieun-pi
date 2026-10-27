# durable

A prototype of sieun-pi on `@earendil-works/pi-durable` 1.4.0.
It opens one pi-durable Harness on a SQLite file, with a root conversation on `anthropic/claude-opus-5-5` through pi-pool and a foreground subagent tool whose child conversation the root's run waits on.
Its test kills the host with SIGKILL mid-turn, reopens the same file in a new process and checks that the run finishes with nothing lost or doubled.

Nothing here is live.

## Files

| Path | What it holds |
|---|---|
| `src/host.ts` | `openDurableHost()`: the SQLite storage, the registry with the preamble and the subagent, and the root conversation. |
| `src/pool-provider.ts` | `poolProvider()`: a pi-ai `Provider` that asks pi-pool's token hook for each request's account and turns a slot wait into a stored sleep. |
| `src/subagent.ts` | The `subagent` tool: a replay-safe call that owns one child conversation and returns its answer. |
| `test/crash-worker.ts` | One host process: `start` submits and reports what runs, `inspect` reads the file read-only, `resume` resumes and waits. |
| `test/crash-rig.ts` | Runs the worker phases, kills at a chosen event and lists what a crash broke. |
| `test/crash-scenario.ts` | The input, the child task and the faux model's answers. |
| `test/crash.test.ts` | Three faux crash cases for CI and the real-model case behind `PI_DURABLE_REAL=1`. |

## Dependencies

The package uses `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` 1.4.0, which install in `components/pi-stack/node_modules` with `npm install` there.
It also imports two pi-stack folders by relative path: `../pool/src/pool-cli.ts` and `../pool/src/errors.ts` for the token hook, the session key, the slot-wait answer and the 429 rewrite, and `../shared/preamble.ts` for Prime's base prompt.

## How a request gets its account

```mermaid
sequenceDiagram
participant G as pi.generation task
participant P as poolProvider
participant H as pi-pool-token
participant A as api.anthropic.com
G->>P: streamSimple, sessionId of the conversation
P->>H: --provider anthropic, PI_POOL_SESSION_KEY = the file's tree
alt token
  H-->>P: sk-ant-oat01 token
  P->>A: the request, through pi-ai's anthropic provider
  A-->>G: the stream; a 429 goes to pi-pool limited as in ../pool
else exit 75 with retryAt
  H-->>P: slot wait
  P-->>G: stopReason deferred, pollAfterMs up to 30 s
  G->>G: commit a sleep until pollAt (survives a restart)
  G->>P: fetchDeferred at pollAt
  P->>H: ask again
  P-->>G: still waiting: deferred again; slot open: a retryable error
  G->>P: retry after settings.retry backoff, with a fresh vend
end
```

1. One SQLite file is one pool tree: `PI_POOL_SESSION_KEY` carries `pi-durable:<file>` as the root and the conversation's `pi.provider` session id as the active session, so a child conversation draws from the root's account.
2. A slot wait holds no request and no timer in memory beyond the Harness's own wake, because the generation task stores `{ phase: "poll", pollAt }` and sleeps.
3. A poll that finds the slot open ends with a retryable error, because pi-durable's `fetchDeferred` gets only the handle and not the transcript; the generation's retry then sends the request, which costs one attempt of `settings.retry.maxRetries` per slot wait.
4. pi-pool's turn queue (`admit` and `release` around a run) is not wired here yet.

## What the crash test proves

1. A SIGKILL while the root's model stream runs leaves the cut-off answer as an aborted entry, and the reopened process retries the request and finishes the run.
2. A SIGKILL while the child conversation streams reruns the replay-safe subagent call, which finds the same child and the same child submission by request id, so the child is asked once and its answer is the tool result.
3. A SIGKILL during a pool slot wait leaves a stored sleep, and the reopened process polls at its time and sends the request at the slot.
4. In every case the root has one user entry before and after the restart, the input settles `done` once, and the root has one final answer.

## Checks

```sh
cd components/pi-stack
npm run typecheck
node --import tsx --test --test-force-exit --test-isolation=none durable/test/crash.test.ts
PI_DURABLE_REAL=1 PI_DURABLE_KILL=child-partial,root-partial node --import tsx --test --test-force-exit --test-isolation=none --test-name-pattern="real model" durable/test/crash.test.ts
```

The real case writes `crash-real-<kill point>.json` to `PI_DURABLE_OUT`, by default `~/work/pi-durable-fit`.

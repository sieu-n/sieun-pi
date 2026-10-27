# pi-stack

pi-stack rebuilds Prime Agent on upstream Pi (`@earendil-works/pi-coding-agent` 1.4.0).
It holds one session host and the Pi extensions that replace Prime's daemon, RLM kernel, agent messaging and continual harness.
The plan, the 126 feature rows and the probes behind them are on the wiki page `sessions/2026/10/27/1301-prime-to-pi-extension/findings.html`, with notes in `~/work/pi-migration-research/`.

Nothing here is live.
The live chat on :5182, pi-pool's install and every live session stay on Prime until the owner decides the cutover.

## Layout

| Folder | Build step | What it holds |
|---|---|---|
| `host/` | 1, 6 | `pi-host`, one Node process on the Pi SDK that holds many sessions behind a unix socket speaking a subset of Prime's v7 JSONL envelope, plus its scheduler for heartbeats and wakes. |
| `rlm/` | 2 | The `pi-rlm` extension: the `ipython` tool, `bash()` notices, in-process `rlm.spawn` children, and the vendored MIT Prime Python runtime under `rlm/python/`. |
| `agent-bus/` | 3 | The `pi-agent-bus` extension: `agent_message` and `agent_observe`, routed in-process for one tree and through pi-host for roots and closed sessions. |
| `harness/` | 4 | The `pi-harness` extension: the same `harness_state.json` format, digest injection, `/refine`, auto-refine and rollback. |
| `pool/` | 5 | The pi-pool hooks on `before_provider_headers` and `message_end`. |
| `shared/` | all | Code two or more parts share, such as the process-wide agent registry in `shared/registry.ts`. |
| `test/` | all | Shared test helpers, such as the faux provider runtime in `test/faux.ts`. |

Each folder is a Pi package of its own, and all of them share this folder's `node_modules`.
Run `npm install` here once.
The repo root's `node_modules` maps `@earendil-works/pi-coding-agent` to Prime 0.9.8, so code in this folder must resolve upstream Pi from `components/pi-stack/node_modules`.

## Rules every part follows

1. One pi-host process holds many sessions and loads each extension module once, so an extension keeps per-session state in its factory closure or in a map keyed by `ctx.sessionManager.getSessionId()`, never in a module-level variable.
2. A session finds its identity (name, parent, depth) through `shared/registry.ts`, and pi-rlm assigns a child's identity before it opens the child.
3. An extension reaches pi-host through the socket in `PI_HOST_SOCKET`. In a plain `pi` CLI that variable is unset, and a host-only feature, such as messaging a closed root, fails with a message that says it needs pi-host.
4. Tests run with `node --import tsx --test --test-force-exit`, and a single file adds `--test-isolation=none`.
5. Test rigs set `PI_OFFLINE=1`, `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`, and use their own `PI_CODING_AGENT_DIR`.

## Checks

```sh
cd components/pi-stack
npm install
npm run typecheck
npm test
```

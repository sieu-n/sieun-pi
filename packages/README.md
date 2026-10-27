# packages

This folder holds the Pi side of sieun-pi: the pi-host session host and the Pi extensions that replace Prime's daemon, RLM kernel, agent messaging and continual harness, all on upstream Pi (`@earendil-works/pi-coding-agent` 1.4.0).
The target layout is the wiki page `sessions/2026/10/28/0421-sieun-pi-final-layout/layout.html`, and the plan, the 126 feature rows and the probes behind them are on `sessions/2026/10/27/1301-prime-to-pi-extension/findings.html`.

Nothing here is live except pi-host.service on us-metal02, which runs a pinned export.
The live chat on :5182, pi-pool's install and every live session stay on Prime until the switch.

## Layout

| Folder | What it holds |
|---|---|
| `pi-host/` | One Node process on the Pi SDK that holds many sessions behind a unix socket speaking a subset of Prime's v7 JSONL envelope, plus its scheduler for heartbeats and wakes. `prototype/` holds the pi-durable host prototype and its SIGKILL crash test. |
| `pi-rlm/` | The `ipython` tool, `bash()` notices, in-process `rlm.spawn` children and the vendored MIT Prime Python runtime under `python/`. `agent-bus/` holds `agent_message` and `agent_observe`, routed in-process for one tree and through pi-host for roots and closed sessions. |
| `pi-harness/` | The continual harness: the same `harness_state.json` format, digest injection, `/refine`, auto-refine and rollback. |
| `pi-pool/` | The pi-pool hooks on `before_provider_headers` and `message_end`. |
| `pi-family/` | The process-wide agent registry and kernel bridge that two or more packages share. |
| `pi-testkit/` | Shared test helpers, such as the faux provider runtime in `faux.ts`. |
| `sieun-rules/` | The Pi tests and pi-host check rig for `components/global-rules`, `components/claude-rules` and `components/user-history/extension`, which `pi-host/extensions.json` loads in every session. |

All of them share this folder's `package.json` and `node_modules` until the switch, when the repo root becomes the npm workspace root.
The repo root's `node_modules` maps `@earendil-works/pi-coding-agent` to Prime 0.9.8 for the live runtime, so code in this folder must resolve upstream Pi from `packages/node_modules`.
Run `npm ci` here once.

## Rules every part follows

1. One pi-host process holds many sessions and loads each extension module once, so an extension keeps per-session state in its factory closure or in a map keyed by `ctx.sessionManager.getSessionId()`, never in a module-level variable.
2. A session finds its identity (name, parent, depth) through `pi-family/registry.ts`, and pi-rlm assigns a child's identity before it opens the child.
3. An extension reaches pi-host through the socket in `PI_HOST_SOCKET`. In a plain `pi` CLI that variable is unset, and a host-only feature, such as messaging a closed root, fails with a message that says it needs pi-host.
4. Tests run with `node --import tsx --test --test-force-exit`, and a single file adds `--test-isolation=none`.
5. Test rigs set `PI_OFFLINE=1`, `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`, and use their own `PI_CODING_AGENT_DIR`.

## Checks

```sh
cd packages
npm install
npm run typecheck
npm test
```

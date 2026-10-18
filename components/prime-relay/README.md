# prime-relay

prime-relay is a small HTTP server that runs on every box and exposes that box's Prime daemon socket over the tailnet. It checks a bearer token on every request and knows nothing about sieun-pi, chats or other boxes.

## API

Every request needs `Authorization: Bearer <token>`, and a request without it gets 401.

- `GET /v1/health` returns `{"ok":true,"daemon":"answering"|"down","version":1}`.
- `GET /v1/daemon` with `Connection: Upgrade` and `Upgrade: prime-daemon` answers 101 and then carries raw bytes both ways to the daemon socket, so the JSONL protocol passes through unparsed.
- `GET /v1/host` returns the box's CPU, memory and memory groups (cgroups on Linux, the pressure feed on macOS) and its own `pi-pool queue --json` and `pi-pool config` unparsed, from `host-stats.ts`; Settings > Hosts draws one card per box from it.
- `POST /v1/watch` takes worker pids, one per line, and returns `{"usable":...,"footprints":...}`: the box's usability reading (the raw pressure feed on macOS, PSI, swap-outs and runnable tasks a core over the CPUs the relay may run on, on Linux, from `host-stats.ts`) and those workers' footprints from sieun-pi's `worker-footprint.py`, which the install copies beside the relay. The chat service's watch reads every other box this way, so sleeping_gb and the worker totals cover each box.
- `GET /v1/file?path=<absolute path>` reads a file under the configured roots, by default `~/.prime/agent/sessions` and `~/.prime/agent/session-artifacts`, and any other path gets 403. `Range: bytes=N-` returns 206 from offset N, `HEAD` returns the size, and a folder returns `{"entries":[...]}`.

## Install

Run `node components/prime-relay/install.mjs --ref <commit>` from a sieun-pi checkout on the box. It copies `relay.mjs`, `host-stats.ts` and `components/user-history/src/worker-footprint.py` from that commit to `~/.local/share/prime-relay`, writes `~/.config/prime-relay/relay.json` and a 0600 token file when they are missing, and restarts `prime-relay.service` (systemd user unit) on Linux or `com.sieun.prime-relay` (launchd) on macOS. The relay listens on the box's `tailscale ip -4` at port 7790 unless `--listen` or `--port` says otherwise.

The sieun-pi side lives in `components/user-history/src/hosts.ts`. It reads `~/.config/sieun-pi/hosts.json`, opens `~/.local/state/sieun-pi/hosts/<host>.sock` for every other host so `new DaemonClient(path)` reaches that host unchanged, and reads remote session files with `readHostFile`. `sieun-pi hosts list|start|read|transcript` drives the same code from a shell.

## Moving a chat to another box

Prime finds a stopped subagent through its per-box spawn ledger (`~/.prime/agent/rlm-ledger/<hash>.jsonl`), and a chat tree copied in from another box brings its children's files but no ledger edges, so the daemon answers `Unknown active session` for each of them. After the copy, run `python3 components/prime-relay/adopt-moved-subagents.py --apply` on the receiving box. It appends one spawn edge per child that has none, and it adds ` before move` to a child whose name the parent already gave to a fresh copy. Without `--apply` it only prints the edges, and a second run appends nothing.

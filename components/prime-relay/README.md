# prime-relay

prime-relay is a small HTTP server that runs on every box and exposes that box's Prime daemon socket over the tailnet. It checks a bearer token on every request and knows nothing about sieun-pi, chats or other boxes.

## API

Every request needs `Authorization: Bearer <token>`, and a request without it gets 401.

- `GET /v1/health` returns `{"ok":true,"daemon":"answering"|"down","version":1}`.
- `GET /v1/daemon` with `Connection: Upgrade` and `Upgrade: prime-daemon` answers 101 and then carries raw bytes both ways to the daemon socket, so the JSONL protocol passes through unparsed.
- `GET /v1/file?path=<absolute path>` reads a file under the configured roots, by default `~/.prime/agent/sessions` and `~/.prime/agent/session-artifacts`, and any other path gets 403. `Range: bytes=N-` returns 206 from offset N, `HEAD` returns the size, and a folder returns `{"entries":[...]}`.

## Install

Run `node components/prime-relay/install.mjs --ref <commit>` from a sieun-pi checkout on the box. It copies `relay.mjs` from that commit to `~/.local/share/prime-relay`, writes `~/.config/prime-relay/relay.json` and a 0600 token file when they are missing, and restarts `prime-relay.service` (systemd user unit) on Linux or `com.sieun.prime-relay` (launchd) on macOS. The relay listens on the box's `tailscale ip -4` at port 7790 unless `--listen` or `--port` says otherwise.

The sieun-pi side lives in `components/user-history/src/hosts.ts`. It reads `~/.config/sieun-pi/hosts.json`, opens `~/.local/state/sieun-pi/hosts/<host>.sock` for every other host so `new DaemonClient(path)` reaches that host unchanged, and reads remote session files with `readHostFile`. `sieun-pi hosts list|start|read|transcript` drives the same code from a shell.

# legacy/prime

This folder holds every piece of sieun-pi that only Prime Agent uses.
Each piece keeps the live Prime setup running until the boxes switch to Pi, and the whole folder is deleted after the switch.
The layout is the wiki page `sessions/2026/10/28/0421-sieun-pi-final-layout/layout.html`.

| Folder | What it did | What replaces it after the switch |
|---|---|---|
| `daemon-keeper/` | Restarts the Prime daemon on the Mac when it stops answering. | The pi-host unit restart. |
| `idle-reaper/` | Stops idle Prime workers on the Mac. | Nothing, because pi-host runs every session in one process. |
| `usage-feed/` | Sends Prime's model call usage from session transcripts to LGTM. | pi-telemetry from pi-host. |
| `deploy/` | The Prime daemon unit, `prime-agent-daemon-ctl`, the `prime-agent` wrapper and `prime-install.sh`. | `pi-host.service`. |
| `scripts/` | `sync-prime-agent.mjs`, which moves the SDK to the installed Prime version, and `prove_runtime.mjs`, which proves the runtime loads in Prime. | `scripts/check-standalone.mjs` and the release scripts. |
| `skills/` | `resume-paused-sessions` and the `skills.prime_agent` helpers, such as `fleet_health`. | `harness.resume()` in pi-host. |
| `tests/` | The tests of the pieces above. | The packages' own tests. |
| `utils/` | `prime-context.mjs` and `prime-version.mjs`. | Nothing. |

Each installer here still installs into the same place as before the move, so a box that reinstalls a piece from this folder gets the same files.

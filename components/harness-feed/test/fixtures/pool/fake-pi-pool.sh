#!/bin/sh
# A stand-in pi-pool for the reader test: it answers `snapshot --json ...` with the fixture and records its argv and the session variable it got.
printf '%s|%s\n' "$*" "$PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID" >> "$PI_POOL_ARGV_LOG"
exec cat "$(dirname "$0")/snapshot.json"

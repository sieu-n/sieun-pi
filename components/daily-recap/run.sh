#!/bin/bash
set -eEuo pipefail
trap 'rc=$?; echo "daily-recap failed (exit $rc) at line $LINENO" >&2' ERR
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$(dirname "$DIR")"
if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  exec "${PYTHON_BIN:-python3}" "$DIR/daily_recap.py" "$@"
fi
if [[ ! -f "$HOME_DIR/config.env" ]]; then
  echo "daily-recap: missing $HOME_DIR/config.env; run the installer with --write first" >&2
  exit 2
fi
set -a
source "$HOME_DIR/config.env"
set +a
export PATH="${NODE_BIN_DIR:+$NODE_BIN_DIR:}${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export DAILY_RECAP_HOME="$HOME_DIR"
cd "$HOME_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily-recap start args=$*"
PREVIEW=0
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then PREVIEW=1; fi
done
# launchd can fire on wake before DNS returns. Only configured posts need this wait.
if [[ "$PREVIEW" == 0 && -n "${SLACK_BOT_TOKEN:-}" && -n "${SLACK_CHANNEL:-}" ]]; then
  READY=0
  for ((attempt=0; attempt<30; attempt++)); do
    if curl -fsS --max-time 5 -o /dev/null https://slack.com/api/api.test; then
      READY=1
      break
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] no network yet, waiting 30s" >&2
    sleep 30
  done
  if [[ "$READY" == 0 ]]; then
    echo "daily-recap: Slack network check failed after 30 attempts; recap not run" >&2
    exit 1
  fi
fi
rc=0
"${PYTHON_BIN:-python3}" "$DIR/daily_recap.py" "$@" || rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily-recap exit $rc"
exit "$rc"

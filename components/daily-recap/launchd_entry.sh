#!/bin/bash
# Use only an existing user tmux server. Starting one here would inherit launchd's TCC denial.
set -euo pipefail
unset TMUX
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$(dirname "$DIR")"
if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  exec /bin/bash "$DIR/run.sh" "$@"
fi
LOG_DIR="$HOME_DIR/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
LOG="$LOG_DIR/run-$STAMP.log"
if tmux list-sessions >/dev/null 2>&1; then
  SESSION="daily-recap-$STAMP"
  printf -v COMMAND '%q ' /bin/bash "$DIR/run.sh" "$@"
  printf -v REDIRECT ' >> %q 2>&1' "$LOG"
  if tmux new-session -d -s "$SESSION" -c "$HOME_DIR" "$COMMAND$REDIRECT"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] dispatched to tmux session $SESSION, log $LOG"
    exit 0
  fi
  echo "daily-recap: tmux new-session failed; running directly with --no-repo" >&2
fi
echo "[$(date '+%Y-%m-%d %H:%M:%S')] no user tmux dispatch: running directly with --no-repo, log $LOG"
/bin/bash "$DIR/run.sh" --no-repo "$@" >> "$LOG" 2>&1

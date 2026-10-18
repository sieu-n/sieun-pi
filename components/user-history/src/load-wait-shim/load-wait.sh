# Sourced in front of a shell command that loops on the Mac's load (load-wait.ts, load-wait-end.py). The first `sleep` after a load read
# (sysctl, uptime or memory_pressure here, or os.getloadavg in a Python process with the load-wait shim) ends the shell with exit 75.
# A command substitution runs in a subshell, so the read leaves a marker file named after this shell's pid instead of a variable.
export USER_HISTORY_LOAD_READ="${TMPDIR:-/tmp}/user-history-load-read-$$"
rm -f "$USER_HISTORY_LOAD_READ"
sysctl() { : > "$USER_HISTORY_LOAD_READ" 2>/dev/null; command sysctl "$@"; }
uptime() { : > "$USER_HISTORY_LOAD_READ" 2>/dev/null; command uptime "$@"; }
memory_pressure() { : > "$USER_HISTORY_LOAD_READ" 2>/dev/null; command memory_pressure "$@"; }
sleep() {
  if [ -e "$USER_HISTORY_LOAD_READ" ]; then
    rm -f "$USER_HISTORY_LOAD_READ"
    printf '%s\n' 'user-history: the load wait ended after its first check (c47); run the check now' >&2
    exit 75
  fi
  command sleep "$@"
}

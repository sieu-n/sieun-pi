#!/usr/bin/env bash
# Memory and CPU order of us-metal02 as root: the harness first, the CI guests next, the dev apps last (agreed
# with the VP of CI on 2026-10-18). Run it again any time; it writes drop-ins and reloads, and restarts nothing.
# Protection does the ordering, so nothing in the dev half carries MemoryHigh or a tight MemoryMax (owner rules
# c88, c92, c98). With 69G on user-1001.slice and 45G on dev.slice, both slices sat at their caps, held
# 7.8 GiB in swap and logged 100070 memory.max events on 10-18 while the host had 132 GiB available.
# 1. The harness units get MemoryMin, sized from their peak RSS on 10-18 plus headroom: the Prime daemon and its
#    workers (31.6G) 40G, the chat on :5182 (3.3G) 5G, pi-pool on :7781 (0.4G) 1G, the relay on :7790 (0.1G)
#    256M, and the pm2 unit that runs the llm-wiki dev server on :5176 (3.4G) 5G. Every ancestor up to the root
#    carries the sum, because a cgroup's protection never exceeds its parent's.
# 2. virev-ci.slice gets MemoryLow equal to its MemoryMax: seven running 20 GiB guests plus QEMU, so the kernel
#    reclaims the dev half before any guest page. virev-prod.slice gets MemoryLow 10G (peak 9.2G).
# 3. user-1001.slice has no MemoryMax. Its processes run with oom_score_adj 100 to 200 and the QEMU guests with 0,
#    so a whole-box out-of-memory kills dev-half work before a guest. dev.slice keeps a last-resort MemoryMax of
#    the box's RAM minus CI's 148G, prod's 10G and 10G for the kernel, because its docker processes run at
#    oom_score_adj 0 like the guests.
# 4. The harness units get OOMPolicy=continue, so one OOM kill of a worker never stops the whole daemon unit.
# 5. CPU goes by weight, never by a pin on the dev user: user-1001.slice spans all 80 threads, because pinned to 32
#    the harness reached 22 of them at 07:35Z and 07:37Z on 10-18. Under contention user.slice (CPUWeight 1000)
#    goes before virev.slice (100, the CI and prod slices keep their own CPU sets and weights) and dev.slice (25,
#    still pinned by setup-host.sh), and inside the user manager the harness units (1000) go before the dev apps
#    (100). A weight only acts when CPUs are busy, so it never slows anything on an idle box.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
CI_LOW=${CI_LOW:-148G}
PROD_LOW=${PROD_LOW:-10G}
VIREV_LOW=${VIREV_LOW:-158G}
DEV_MEMORY_MAX=${DEV_MEMORY_MAX:-79G}
HARNESS_UNITS=${HARNESS_UNITS:-"prime-agent-daemon.service=40G sieun-pi-chat.service=5G pi-pool-serve.service=1G prime-relay.service=256M auto-sns-dev-pm2.service=5G"}
HARNESS_MIN=${HARNESS_MIN:-52480M}
USER_CPU_WEIGHT=${USER_CPU_WEIGHT:-1000}
CI_CPU_WEIGHT=${CI_CPU_WEIGHT:-100}
DEV_CPU_WEIGHT=${DEV_CPU_WEIGHT:-25}

uid=$(id -u "$DEV_USER")
home=$(getent passwd "$DEV_USER" | cut -d: -f6)

dropin() { # unit dir, file body
  install -d "$1"
  rm -f "$1/50-memory-order.conf"
  printf '%s\n' "$2" > "$1/50-order.conf"
}
dropin /etc/systemd/system/virev.slice.d "$(printf '[Slice]\nMemoryLow=%s\nCPUWeight=%s' "$VIREV_LOW" "$CI_CPU_WEIGHT")"
dropin /etc/systemd/system/virev-ci.slice.d "$(printf '[Slice]\nMemoryLow=%s' "$CI_LOW")"
dropin /etc/systemd/system/virev-prod.slice.d "$(printf '[Slice]\nMemoryLow=%s' "$PROD_LOW")"
dropin /etc/systemd/system/dev.slice.d "$(printf '[Slice]\nMemoryMax=%s\nCPUWeight=%s' "$DEV_MEMORY_MAX" "$DEV_CPU_WEIGHT")"
dropin /etc/systemd/system/user.slice.d "$(printf '[Slice]\nMemoryMin=%s\nCPUWeight=%s' "$HARNESS_MIN" "$USER_CPU_WEIGHT")"
dropin "/etc/systemd/system/user-$uid.slice.d" "$(printf '[Slice]\nMemoryMin=%s\nMemoryMax=infinity\nCPUWeight=%s' "$HARNESS_MIN" "$USER_CPU_WEIGHT")"
dropin "/etc/systemd/system/user@$uid.service.d" "$(printf '[Service]\nMemoryMin=%s\nCPUWeight=%s' "$HARNESS_MIN" "$USER_CPU_WEIGHT")"

userdir="$home/.config/systemd/user"
dropin "$userdir/app.slice.d" "$(printf '[Slice]\nMemoryMin=%s\nCPUWeight=%s' "$HARNESS_MIN" "$USER_CPU_WEIGHT")"
for pair in $HARNESS_UNITS; do
  dropin "$userdir/${pair%%=*}.d" "$(printf '[Service]\nMemoryMin=%s\nOOMPolicy=continue\nCPUWeight=%s' "${pair#*=}" "$USER_CPU_WEIGHT")"
done
chown -R "$DEV_USER:$DEV_USER" "$userdir"

systemctl daemon-reload
systemctl --user -M "$DEV_USER@" daemon-reload

echo "order: harness MemoryMin $HARNESS_MIN and CPUWeight $USER_CPU_WEIGHT, dev.slice CPUWeight $DEV_CPU_WEIGHT, virev.slice CPUWeight $CI_CPU_WEIGHT, virev-ci.slice MemoryLow $CI_LOW, virev-prod.slice MemoryLow $PROD_LOW, dev.slice MemoryMax $DEV_MEMORY_MAX, user-$uid.slice MemoryMax infinity"

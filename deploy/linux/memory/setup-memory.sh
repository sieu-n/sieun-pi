#!/usr/bin/env bash
# Sets up the memory layers of https://cho.sh/ko/1983DC on a Linux box as root (owner ask, 2026-10-19). Each step converges,
# so run it again any time. DEV_USER gets heavy on PATH. The Memory layers section of ../README.md explains each layer and its numbers.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
SWAP_FILE=${SWAP_FILE:-/swapfile}
SWAP_GIB=${SWAP_GIB:-64}
here=$(cd "$(dirname "$0")" && pwd)

# 1. A swap file written with dd, since swapon refuses a file with holes that fallocate can leave. oflag=direct keeps the
# 64 GiB of zeros out of the page cache of a box that is short of memory.
if ! grep -q "^$SWAP_FILE " /proc/swaps; then
  if [ ! -f "$SWAP_FILE" ]; then
    dd if=/dev/zero of="$SWAP_FILE" bs=4M count=$((SWAP_GIB * 256)) oflag=direct status=none
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
fi
grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab

# 2. zswap with zstd, from a unit at boot and now.
install -m 644 "$here/zswap-zstd.service" /etc/systemd/system/zswap-zstd.service
systemctl daemon-reload
systemctl enable zswap-zstd.service >/dev/null
systemctl restart zswap-zstd.service

# 3. earlyoom at 5% and 2%, with oom-kill-session.py as its -N hook, and without the packaged unit's memory and task caps.
command -v earlyoom >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq earlyoom
install -d /usr/local/lib/oom-protect
install -m 755 "$here/oom-protect.py" /usr/local/lib/oom-protect/oom-protect.py
install -m 755 "$here/oom-kill-session.py" /usr/local/lib/oom-protect/oom-kill-session.py
install -m 644 "$here/earlyoom.default" /etc/default/earlyoom
install -d /etc/systemd/system/earlyoom.service.d
install -m 644 "$here/earlyoom-limits.conf" /etc/systemd/system/earlyoom.service.d/limits.conf
systemctl daemon-reload
systemctl enable earlyoom >/dev/null
systemctl restart earlyoom
# sieun reads earlyoom's kills from the system journal for harness-feed's memory row; the default ACL covers rotated journal files.
setfacl -R -m u:sieun:rX -m d:u:sieun:rX /var/log/journal

# 5. OOM scores: -500 for ssh and tailscaled at their next start and now, and -900 for the harness core by oom-protect.
for unit in ssh tailscaled; do
  install -d "/etc/systemd/system/$unit.service.d"
  printf '[Service]\nOOMScoreAdjust=-500\n' > "/etc/systemd/system/$unit.service.d/oom-score.conf"
  pid=$(systemctl show -p MainPID --value "$unit")
  [ "$pid" -gt 0 ] && echo -500 > "/proc/$pid/oom_score_adj"
done
install -m 644 "$here/oom-protect.service" /etc/systemd/system/oom-protect.service
systemctl daemon-reload
systemctl enable oom-protect.service >/dev/null
systemctl restart oom-protect.service

# 7. THP defrag "defer" at boot and now, so a CI VM's huge page fault no longer compacts memory in place.
install -m 644 "$here/thp-defrag.service" /etc/systemd/system/thp-defrag.service
systemctl daemon-reload
systemctl enable thp-defrag.service >/dev/null
systemctl restart thp-defrag.service

# 6. sysctls.
install -m 644 "$here/90-agent-memory.conf" /etc/sysctl.d/90-agent-memory.conf
sysctl -q -p /etc/sysctl.d/90-agent-memory.conf

# 4. heavy on DEV_USER's PATH.
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
install -d -m 755 -o "$DEV_USER" -g "$DEV_USER" "$home/.local/bin"
install -m 755 -o "$DEV_USER" -g "$DEV_USER" "$here/heavy" "$home/.local/bin/heavy"

swapon --show
echo "zswap $(cat /sys/module/zswap/parameters/enabled) $(cat /sys/module/zswap/parameters/compressor); thp defrag $(cat /sys/kernel/mm/transparent_hugepage/defrag); earlyoom $(systemctl is-active earlyoom); oom-protect $(systemctl is-active oom-protect)"

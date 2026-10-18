#!/usr/bin/env bash
# Sets up the dev half of us-metal02 as root. Run it again any time; each step converges.
# Split agreed with VP of CI on 2026-10-15: CI gets 24 of the 40 cores and 60% of RAM and disk,
# dev gets 16 cores and about 100 GB of RAM in dev.slice. Dev takes the last 16 cores of NUMA node 1
# with their hyperthread siblings, so CI keeps all of node 0 plus 4 cores of node 1.
# dev.slice (docker and containerd) gets MemoryMax 70G and the dev user's slice 40G. Both may only
# allocate on node 1 (121.9 GiB), so the two caps together (110 GiB) fit inside it.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
NODE=${DEV_NODE:-1}
DEV_CORES=${DEV_CORES:-16}
DEV_MEMORY_MAX=${DEV_MEMORY_MAX:-70G}
USER_MEMORY_MAX=${USER_MEMORY_MAX:-40G}
MAC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMpr4avzF8JvlVt6La1Bn6mcas7cMvoUnLtFGXMyHJMr claude-code-langfuse-migration-2026-05-08'

# One line per physical core of the node: its sibling list, such as "20,60". Keep the last DEV_CORES of them.
siblings=$(for c in $(cat /sys/devices/system/node/node$NODE/cpulist | tr ',' '\n' | while IFS=- read a b; do seq "$a" "${b:-$a}"; done); do
  cat /sys/devices/system/cpu/cpu$c/topology/thread_siblings_list; done | sort -u -t, -k1,1n)
have=$(echo "$siblings" | wc -l)
[ "$have" -ge "$DEV_CORES" ] || { echo "node $NODE has $have cores, need $DEV_CORES" >&2; exit 1; }
cpus=$(echo "$siblings" | tail -n "$DEV_CORES" | paste -sd, -)
echo "$cpus" > /etc/virev-dev-cpus

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl xz-utils python3 lsof libstdc++6 unzip numactl build-essential

id -u "$DEV_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEV_USER"
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
grep -qxF "$MAC_KEY" "$home/.ssh/authorized_keys" || echo "$MAC_KEY" >> "$home/.ssh/authorized_keys"
chown "$DEV_USER:$DEV_USER" "$home/.ssh/authorized_keys"; chmod 600 "$home/.ssh/authorized_keys"
chmod 750 "$home"

cat > /etc/systemd/system/dev.slice <<EOF
[Unit]
Description=Dev half of us-metal02: the owner's Prime Agent and sieun-pi chat
[Slice]
AllowedCPUs=$cpus
AllowedMemoryNodes=$NODE
MemoryMax=$DEV_MEMORY_MAX
IOWeight=200
EOF
# The dev user's logins and user services (the chat, the daemon, the wiki) land under the same fence.
uid=$(id -u "$DEV_USER")
install -d /etc/systemd/system/user-$uid.slice.d
cat > /etc/systemd/system/user-$uid.slice.d/dev.conf <<EOF
[Slice]
AllowedCPUs=$cpus
AllowedMemoryNodes=$NODE
MemoryMax=$USER_MEMORY_MAX
IOWeight=200
EOF
loginctl enable-linger "$DEV_USER"
systemctl daemon-reload
systemctl start dev.slice

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
tailscale set --operator="$DEV_USER" 2>/dev/null || true
tailscale status >/dev/null 2>&1 || echo "run: tailscale up --ssh --hostname us-metal02-dev --operator=$DEV_USER"
echo "dev: cpus $cpus (node $NODE, $DEV_CORES cores), MemoryMax $DEV_MEMORY_MAX for dev.slice and $USER_MEMORY_MAX for user-$uid.slice; CI takes every other cpu, listed by: cat /etc/virev-dev-cpus"

#!/usr/bin/env bash
# Sets up the dev half of us-metal02 as root. Run it again any time; each step converges.
# It sets no memory or CPU limit, reservation, pin or weight on any slice or unit (owner, 2026-10-18: "그냥 없애
# remove all the bullshit i didn't explicitly asked for!!"). The only load control is the optional agent queue.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
MAC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMpr4avzF8JvlVt6La1Bn6mcas7cMvoUnLtFGXMyHJMr claude-code-langfuse-migration-2026-05-08'

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl xz-utils python3 lsof libstdc++6 unzip numactl build-essential

id -u "$DEV_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEV_USER"
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
grep -qxF "$MAC_KEY" "$home/.ssh/authorized_keys" || echo "$MAC_KEY" >> "$home/.ssh/authorized_keys"
chown "$DEV_USER:$DEV_USER" "$home/.ssh/authorized_keys"; chmod 600 "$home/.ssh/authorized_keys"
chmod 750 "$home"

# Docker puts its containers under dev.slice (cgroup-parent in /etc/docker/daemon.json).
cat > /etc/systemd/system/dev.slice <<EOF
[Unit]
Description=Dev half of us-metal02: docker (cgroup-parent dev.slice)
[Slice]
EOF
loginctl enable-linger "$DEV_USER"
systemctl daemon-reload
systemctl start dev.slice

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
tailscale set --operator="$DEV_USER" 2>/dev/null || true
tailscale status >/dev/null 2>&1 || echo "run: tailscale up --ssh --hostname us-metal02-dev --operator=$DEV_USER"
echo "dev: no slice limits; dev.slice holds docker, user-$(id -u "$DEV_USER").slice holds the harness and agents"

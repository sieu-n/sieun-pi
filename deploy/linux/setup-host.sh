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
# Port 22 answers only on lo, tailscale0 and wg-prod. The guard owns one nft table; nftables.service stays off because
# /etc/nftables.conf starts with flush ruleset, which would wipe the Docker, ci and wg-prod tables.
here=$(cd "$(dirname "$0")" && pwd)
install -m 644 "$here/ssh-public-guard.nft" /etc/nftables-ssh-guard.nft
install -m 644 "$here/ssh-public-guard.service" /etc/systemd/system/ssh-public-guard.service
systemctl daemon-reload
systemctl enable ssh-public-guard
systemctl restart ssh-public-guard
# The wg-prod guard (wg-prod-guard.nft says what it admits) loads before wg-quick@wg-prod. wg-prod.conf and its key are
# placed by hand; a restart reloads the table in one nft transaction.
install -d -m 700 /etc/wireguard
install -m 600 "$here/wg-prod-guard.nft" /etc/wireguard/wg-prod-guard.nft
install -m 644 "$here/wg-prod-guard.service" /etc/systemd/system/wg-prod-guard.service
systemctl daemon-reload
systemctl enable wg-prod-guard
systemctl restart wg-prod-guard

# ssh to the Mac reuses one of 16 masters (ssh-mac.conf explains why), and ssh-mac-slot picks one by ssh's pid.
install -d -m 755 -o "$DEV_USER" -g "$DEV_USER" "$home/.local" "$home/.local/bin"
install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$home/.ssh/config.d" "$home/.ssh/cm"
install -m 755 -o "$DEV_USER" -g "$DEV_USER" "$here/ssh-mac-slot" "$home/.local/bin/ssh-mac-slot"
sed "s#/home/sieun/#$home/#g" "$here/ssh-mac.conf" > "$home/.ssh/config.d/mac.conf"
chown "$DEV_USER:$DEV_USER" "$home/.ssh/config.d/mac.conf"; chmod 600 "$home/.ssh/config.d/mac.conf"
touch "$home/.ssh/config"
if ! grep -qxF 'Include ~/.ssh/config.d/mac.conf' "$home/.ssh/config"; then
  { echo 'Include ~/.ssh/config.d/mac.conf'; cat "$home/.ssh/config"; } > "$home/.ssh/config.new"
  mv "$home/.ssh/config.new" "$home/.ssh/config"
fi
chown "$DEV_USER:$DEV_USER" "$home/.ssh/config"; chmod 600 "$home/.ssh/config"

echo "dev: no slice limits; dev.slice holds docker, user-$(id -u "$DEV_USER").slice holds the harness and agents"

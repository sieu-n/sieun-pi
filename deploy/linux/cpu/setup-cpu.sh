#!/usr/bin/env bash
# Sets up the CPU layers of deploy/linux/README.md on a Linux box as root, after the owner's t84 answer of 10-19 put CPU priority under
# https://cho.sh/ko/1983DC. Each step converges and applies live without restarting any unit, so run it again any time.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
here=$(cd "$(dirname "$0")" && pwd)
uid=$(id -u "$DEV_USER")
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
user_ctl=(systemctl --user "--machine=$DEV_USER@")
SYSTEM_UNITS=(ssh.service tailscaled.service)
USER_UNITS=(sieun-pi-chat.service pi-pool-serve.service pi-pool-hookd.service)

# 1. CPUWeight=1000 from a drop-in for the next start, and set live now.
for unit in "${SYSTEM_UNITS[@]}"; do
  install -d "/etc/systemd/system/$unit.d"
  install -m 644 "$here/cpu-weight.conf" "/etc/systemd/system/$unit.d/cpu-weight.conf"
done
systemctl daemon-reload
for unit in "${SYSTEM_UNITS[@]}"; do systemctl set-property --runtime "$unit" CPUWeight=1000; done
for unit in "${USER_UNITS[@]}"; do
  install -d -o "$DEV_USER" -g "$DEV_USER" "$home/.config/systemd/user/$unit.d"
  install -m 644 -o "$DEV_USER" -g "$DEV_USER" "$here/cpu-weight.conf" "$home/.config/systemd/user/$unit.d/cpu-weight.conf"
done
"${user_ctl[@]}" daemon-reload
for unit in "${USER_UNITS[@]}"; do "${user_ctl[@]}" set-property --runtime "$unit" CPUWeight=1000; done

# 2. cpu-protect gives the Prime supervisor and its workers nice -10.
install -d /usr/local/lib/cpu-protect
install -m 755 "$here/cpu-protect.py" /usr/local/lib/cpu-protect/cpu-protect.py
install -m 644 "$here/cpu-protect.service" /etc/systemd/system/cpu-protect.service
systemctl daemon-reload
systemctl enable cpu-protect.service >/dev/null
systemctl restart cpu-protect.service
sleep 3

app=/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice
for unit in "${SYSTEM_UNITS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup/system.slice/$unit/cpu.weight")"; done
for unit in "${USER_UNITS[@]}"; do echo "$unit cpu.weight $(cat "$app/$unit/cpu.weight")"; done
echo "prime-agent threads at nice -10: $(ps -L -o ni=,args= -u "$DEV_USER" | awk '$2 ~ /prime-agent$/ && $1 == -10' | wc -l) of $(ps -L -o args= -u "$DEV_USER" | awk '$1 ~ /prime-agent$/' | wc -l)"
echo "cpu-protect $(systemctl is-active cpu-protect)"

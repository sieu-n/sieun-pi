#!/usr/bin/env bash
# Sets up the CPU layers of deploy/linux/README.md on a Linux box as root, after the owner's t84 answer of 10-19 put CPU priority under
# https://cho.sh/ko/1983DC. Each step converges and applies live without restarting any unit, so run it again any time.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
here=$(cd "$(dirname "$0")" && pwd)
uid=$(id -u "$DEV_USER")
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
user_ctl=(systemctl --user "--machine=$DEV_USER@")
# Unit -> CPUWeight, against the default of 100. CI VMs (virev-ci.slice), dev docker (dev.slice) and world rigs (transient user units and ssh
# login scopes) stay at 100, so they never win over agents or prod (c108). The weights at 300 sit on every level from the root down to the
# Prime daemon, because a weight only counts against its siblings: user.slice against virev.slice and dev.slice, user@1001.service against
# the ssh login scopes, and the daemon against the other units in app.slice. virev.slice at 400 holds prod at 300 and CI at 100.
declare -A SYSTEM_WEIGHTS=([ssh.service]=1000 [tailscaled.service]=1000 [user.slice]=300 [user@$uid.service]=300 [virev.slice]=400 [virev-prod.slice]=300)
declare -A USER_WEIGHTS=([sieun-pi-chat.service]=1000 [pi-pool-serve.service]=1000 [pi-pool-hookd.service]=1000 [prime-agent-daemon.service]=300)

dropin() {
  printf '# CPU layer 1 of deploy/linux/README.md (owner'"'"'s t84 answer 10-19, after https://cho.sh/ko/1983DC). A weight is no cap.\n[%s]\nCPUWeight=%s\n' "$1" "$2"
}
section() { case "$1" in *.slice) echo Slice ;; *) echo Service ;; esac; }

# 1. CPUWeight from a drop-in for the next start, and set live now.
for unit in "${!SYSTEM_WEIGHTS[@]}"; do
  install -d "/etc/systemd/system/$unit.d"
  dropin "$(section "$unit")" "${SYSTEM_WEIGHTS[$unit]}" > "/etc/systemd/system/$unit.d/cpu-weight.conf"
done
systemctl daemon-reload
for unit in "${!SYSTEM_WEIGHTS[@]}"; do systemctl set-property --runtime "$unit" "CPUWeight=${SYSTEM_WEIGHTS[$unit]}"; done
for unit in "${!USER_WEIGHTS[@]}"; do
  install -d -o "$DEV_USER" -g "$DEV_USER" "$home/.config/systemd/user/$unit.d"
  dropin "$(section "$unit")" "${USER_WEIGHTS[$unit]}" > "$home/.config/systemd/user/$unit.d/cpu-weight.conf"
  chown "$DEV_USER:$DEV_USER" "$home/.config/systemd/user/$unit.d/cpu-weight.conf"
done
"${user_ctl[@]}" daemon-reload
for unit in "${!USER_WEIGHTS[@]}"; do "${user_ctl[@]}" set-property --runtime "$unit" "CPUWeight=${USER_WEIGHTS[$unit]}"; done

# 2. cpu-protect gives the Prime supervisor and its workers nice -10.
install -d /usr/local/lib/cpu-protect
install -m 755 "$here/cpu-protect.py" /usr/local/lib/cpu-protect/cpu-protect.py
install -m 644 "$here/cpu-protect.service" /etc/systemd/system/cpu-protect.service
systemctl daemon-reload
systemctl enable cpu-protect.service >/dev/null
systemctl restart cpu-protect.service
sleep 3

app=user.slice/user-$uid.slice/user@$uid.service/app.slice
for unit in "${!SYSTEM_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit")/cpu.weight")"; done
for unit in "${!USER_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup/$app/$unit/cpu.weight")"; done
echo "prime-agent threads at nice -10: $(ps -L -o ni=,args= -u "$DEV_USER" | awk '$2 ~ /prime-agent$/ && $1 == -10' | wc -l) of $(ps -L -o args= -u "$DEV_USER" | awk '$1 ~ /prime-agent$/' | wc -l)"
echo "cpu-protect $(systemctl is-active cpu-protect)"

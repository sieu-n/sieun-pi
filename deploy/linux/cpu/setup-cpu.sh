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
# Prime daemon, because a weight only counts against its siblings: user.slice against virev.slice and dev.slice, and the daemon against the
# other units in app.slice. user@1001.service runs at 10000, the most systemd takes, because its siblings are the ssh login scopes, 69 of them
# at 100 each from Mac jobs on 10-19 at 21:1xZ, which at 300 left the user manager about 300/7200 of user-1001.slice when all were busy. virev.slice at 400 holds prod at 300 and CI at 100.
# The Prime daemon runs at 10000 for the same reason one level down: its siblings in app.slice are the job rigs, 67 at 100 on 10-20 at 02:50Z,
# and at 300 its supervisor waited 0.88 s in the run queue per second (0.31 s on CPU), with cpu.pressure some at 57%, and creates took 31 to 43 s.
# At 10000 the wait fell to 0.41 s at load 218 to 265.
# The chat runs at 10000 beside the daemon, and user.slice at 1000 over virev.slice at 400, so the chat's path wins at every level. On 10-20 at
# 06:4xZ virev.slice held 25.5 cores of CI VMs at 100 and 7.1 of prod at 300, and at 400 it outweighed user.slice at 300 at the root, while the
# chat sat at 1000 below the daemon at 10000. Its main thread waited 0.31 s in the run queue per second on CPU and its 15 threads 0.84 s, at load
# 202 to 254; after both changes at 06:41:40Z it waited 0.13 s and 0.35 s at load 204 to 221 (/home/sieun/work/cpu-weights/report.md).
declare -A SYSTEM_WEIGHTS=([ssh.service]=1000 [tailscaled.service]=1000 [user.slice]=1000 [user@$uid.service]=10000 [virev.slice]=400 [virev-prod.slice]=300)
declare -A USER_WEIGHTS=([sieun-pi-chat.service]=10000 [pi-pool-serve.service]=1000 [pi-pool-hookd.service]=1000 [prime-agent-daemon.service]=10000)

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

# 3. rcu-boost runs a thread an RCU stall warning names, so a preempted reader always runs again.
install -m 755 "$here/rcu-boost.py" /usr/local/lib/cpu-protect/rcu-boost.py
install -m 644 "$here/rcu-boost.service" /etc/systemd/system/rcu-boost.service
systemctl daemon-reload
systemctl enable rcu-boost.service >/dev/null
systemctl restart rcu-boost.service
sleep 3

app=user.slice/user-$uid.slice/user@$uid.service/app.slice
for unit in "${!SYSTEM_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit")/cpu.weight")"; done
for unit in "${!USER_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup/$app/$unit/cpu.weight")"; done
echo "prime-agent threads at nice -10: $(ps -L -o ni=,args= -u "$DEV_USER" | awk '$2 ~ /prime-agent$/ && $1 == -10' | wc -l) of $(ps -L -o args= -u "$DEV_USER" | awk '$1 ~ /prime-agent$/' | wc -l)"
echo "cpu-protect $(systemctl is-active cpu-protect)"
echo "rcu-boost $(systemctl is-active rcu-boost), rcu_cpu_stall_timeout $(cat /sys/module/rcupdate/parameters/rcu_cpu_stall_timeout)"

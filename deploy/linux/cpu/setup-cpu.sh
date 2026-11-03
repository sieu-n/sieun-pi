#!/usr/bin/env bash
# Sets up the CPU layers of deploy/linux/README.md on a Linux box as root, after the owner's t84 answer of 10-19 put CPU priority under
# https://cho.sh/ko/1983DC. Each step converges and applies live without restarting any unit, so run it again any time.
set -euo pipefail
DEV_USER=${DEV_USER:-sieun}
here=$(cd "$(dirname "$0")" && pwd)
uid=$(id -u "$DEV_USER")
home=$(getent passwd "$DEV_USER" | cut -d: -f6)
user_ctl=(systemctl --user "--machine=$DEV_USER@")
# Unit -> CPUWeight, against the default of 100. A weight only counts against its siblings, so the root level decides who wins between the
# agents (user.slice) and the CI guests and prod (virev.slice), and the daemon's weight decides it against the other units in app.slice.
# On t68 (10-27) the owner ranked CI above dev box work: "ci shouldn't be a bottleneck (higher priority) than dev box work itself, while it
# shouldn't clog up unnecessary compute when idle". So virev.slice runs at 4000 against user.slice at 1000, and inside it virev-ci.slice runs
# at 300 beside virev-prod.slice at 300, so busy CI outweighs the agents 2 to 1, a busy prod does too, and an idle guest takes nothing.
# measured: from 10-20 to 10-27 at 93-100% host busy, with virev.slice at 400 and CI at 100 inside it, the CI guests saw 34% mean steal and
# 27% of search / e2e jobs hit Convex's 1 s function limit (auto-sns-agent apps/infra/ci-server/RUNBOOK.md, "CPU weight of the CI guests").
# system.slice and dev.slice run at 400, so with virev.slice at 4000 they keep the 5 or so cores they could count on at 100 under 1600 before.
# measured: at 93-100% host busy those two used 2.4 and 3.3 to 4.1 cores. World rigs (transient user units and ssh login scopes) stay at 100.
# user@1001.service runs at 10000, the most systemd takes, because its siblings are the ssh login scopes, 69 of them
# at 100 each from Mac jobs on 10-19 at 21:1xZ, which at 300 left the user manager about 300/7200 of user-1001.slice when all were busy.
# The Prime daemon runs at 10000 for the same reason one level down: its siblings in app.slice are the job rigs, 67 at 100 on 10-20 at 02:50Z,
# and at 300 its supervisor waited 0.88 s in the run queue per second (0.31 s on CPU), with cpu.pressure some at 57%, and creates took 31 to 43 s.
# At 10000 the wait fell to 0.41 s at load 218 to 265.
# The chat runs at 10000 beside the daemon, so its path wins at every level below the root, where a busy virev.slice outweighs user.slice
# since 10-27 (t68); /home/sieun/work/ci-priority-01a17af1/A-report.md reads the chat's run-queue wait after that change. On 10-20 at
# 06:4xZ virev.slice held 25.5 cores of CI VMs at 100 and 7.1 of prod at 300, and at 400 it outweighed user.slice at 300 at the root, while the
# chat sat at 1000 below the daemon at 10000. Its main thread waited 0.31 s in the run queue per second on CPU and its 15 threads 0.84 s, at load
# 202 to 254; after both changes at 06:41:40Z it waited 0.13 s and 0.35 s at load 204 to 221 (/home/sieun/work/cpu-weights/report.md).
# pi-history runs at 10000 beside the chat, whose api/search answers from it: at 03:28Z on 10-28 at load 400 and weight 100, its cpu.pressure
# full read 23% against 4 to 5% for the chat, and searches took p50 433 ms and p90 1.3 s, mostly pi-history waiting for CPU.
declare -A SYSTEM_WEIGHTS=([ssh.service]=1000 [tailscaled.service]=1000 [user.slice]=1000 [user@$uid.service]=10000 [virev.slice]=4000 [virev-prod.slice]=300 [virev-ci.slice]=300 [system.slice]=400 [dev.slice]=400)
# sieun-pi-wiki and auto-sns-dev-pm2 (the wiki and the dev servers duty d1 probes) run at 10000 for the same reason as pi-history.
# measured: on 10-29 at load 200 and weight 100, per CPU-second used the wiki waited 0.35 s and pm2 0.32 s against 0.02 s for the
# chat at 10000; at load 230 :5174 answered in 12.7 s and the wiki in up to 1.1 s while the chat took 0.13 s, and d1 at 06:06Z saw
# the wiki miss its 5 s probe. The wiki's cgroup had waited 220 s on CPU and 0.25 s on memory since its start, so the wait is CPU.
# sieun-pi-apps-chat (sw factory on :5184), pi-host and pi-host-relay run at 10000 for the same reason as sieun-pi-chat, whose place the
# first one takes: each page call reads through the relay and pi-host. measured: on 11-03 at 10:53Z at load 434 and weight 100, per
# CPU-second used the apps-chat main thread waited 3.02 s in the run queue, pi-host 2.36 s and the relay 4.15 s, against 0.39 s for
# sieun-pi-chat at 10000, and the agent page's calls waited 1 to 4.3 s in the browser while their handlers took 1 to 44 ms.
declare -A USER_WEIGHTS=([sieun-pi-chat.service]=10000 [sieun-pi-apps-chat.service]=10000 [pi-host.service]=10000 [pi-host-relay.service]=10000 [pi-history.service]=10000 [sieun-pi-wiki.service]=10000 [auto-sns-dev-pm2.service]=10000 [pi-pool-serve.service]=1000 [pi-pool-hookd.service]=1000 [prime-agent-daemon.service]=10000)

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

# 2. cpu-protect keeps the Prime supervisor and its workers alone in prime-agent-daemon.service and moves the commands they start into
# prime-agent-tools.scope, a sibling in app.slice at the default weight. Its start puts the threads the old nice layer set to -10 back to 0.
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
# 4. favordynmods on the cgroup2 hierarchy, live now and from the kernel line at each boot. Without it every cgroup migration (each unit
# start, each cpu-protect move) waits out an RCU grace period while holding cgroup_threadgroup_rwsem for writing, and every fork on the box
# waits behind it. measured (~/work/cgroup-favordynmods, 10 min windows, box 98 to 99% busy in all four): before, threads sat in
# percpu_rwsem_wait in 9.6 to 12.5% of 200 ms samples, up to 143 at once, a /bin/true spawn took p99 358 to 479 ms and up to 8.0 s, and
# cpu-protect spent 1.9 to 2.6 s in state D; after, with more CI unit starts (2,980 and 3,271 against 2,294 and 2,673), 1 of 5,743 samples
# held a waiter, spawn p99 was 56 to 83 ms, and cpu-protect spent 0 s in state D. A remount needs the current options, since cgroup2
# clears each flag the remount leaves out.
install -m 644 "$here/90-cgroup-favordynmods.cfg" /etc/default/grub.d/90-cgroup-favordynmods.cfg
update-grub
opts=$(findmnt -no OPTIONS /sys/fs/cgroup)
case ",$opts," in *,favordynmods,*) ;; *) mount -o "remount,$opts,favordynmods" /sys/fs/cgroup ;; esac
sleep 3

app=user.slice/user-$uid.slice/user@$uid.service/app.slice
for unit in "${!SYSTEM_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit")/cpu.weight")"; done
for unit in "${!USER_WEIGHTS[@]}"; do echo "$unit cpu.weight $(cat "/sys/fs/cgroup/$app/$unit/cpu.weight")"; done
echo "processes in $app/prime-agent-daemon.service: $(wc -l < "/sys/fs/cgroup/$app/prime-agent-daemon.service/cgroup.procs"), in prime-agent-tools.scope: $(cat "/sys/fs/cgroup/$app/prime-agent-tools.scope/cgroup.procs" 2>/dev/null | wc -l)"
echo "cpu-protect $(systemctl is-active cpu-protect)"
echo "rcu-boost $(systemctl is-active rcu-boost), rcu_cpu_stall_timeout $(cat /sys/module/rcupdate/parameters/rcu_cpu_stall_timeout)"
echo "cgroup2 $(findmnt -no OPTIONS /sys/fs/cgroup), grub lines with cgroup_favordynmods=true: $(grep -c cgroup_favordynmods=true /boot/grub/grub.cfg)"

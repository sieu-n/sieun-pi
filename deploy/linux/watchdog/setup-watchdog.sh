#!/usr/bin/env bash
# Arms the BMC's IPMI hardware watchdog through systemd on a Linux box, as root (README.md next to this file).
# Converges, so run it again any time. A box with no IPMI BMC fails at modprobe and changes nothing else.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -m 644 "$here/ipmi-watchdog.conf" /etc/modules-load.d/ipmi-watchdog.conf
modprobe ipmi_watchdog
install -d /etc/systemd/system.conf.d
install -m 644 "$here/watchdog.conf" /etc/systemd/system.conf.d/watchdog.conf
systemctl daemon-reexec
systemctl show -p WatchdogDevice -p RuntimeWatchdogUSec -p RebootWatchdogUSec

# Hardware watchdog

On 2026-10-27 us-metal02 ran out of RAM and swap at 15:14:50Z. earlyoom stopped one 389 MiB process, the kernel OOM killer stopped at least five more in the next two seconds, and the journal ends at 15:14:58Z. The box then hung with no log for 91 minutes, until someone reset it out of band at 16:46Z. Nothing on the box could have brought it back, because kernel.panic was 0 and no watchdog was armed.

`setup-watchdog.sh` arms the PowerEdge iDRAC's IPMI watchdog. It loads `ipmi_watchdog` at boot (`ipmi-watchdog.conf` in `/etc/modules-load.d/`), and `watchdog.conf` in `/etc/systemd/system.conf.d/` has systemd pet `/dev/watchdog`. If PID 1 stops running for 3 minutes, the BMC hard-resets the box, so a hang costs about 3 minutes plus a boot. `RebootWatchdogSec=10min` resets the box when a reboot itself hangs.

Run it as root on a box with an IPMI BMC. It converges, so a second run changes nothing. Check it with `ipmitool mc watchdog get`, which should read `Started/Running` with `Hard Reset` and a 180 s countdown, and with `journalctl -b | grep -i watchdog`, which should read `Using hardware watchdog /dev/watchdog: 'IPMI'`.

This is a recovery step and caps no work. The memory layers that try to keep the box from running short live in `../memory/`.

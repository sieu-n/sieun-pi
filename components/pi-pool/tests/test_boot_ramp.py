"""The governor's boot and CPU inputs (pool/pressure.py BOOT_CRITICAL_SEC and LOAD_CRITICAL_PER_CPU): after a boot, or while the CPU
is pinned, the turn limit stays at the critical 12 even though memory reads clean, as after the owner's restart at 13:49Z on 10-15.
"""
import unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE  # noqa: F401  (loads vend from this checkout)
from vend.pool import base, pressure, turns


def setUpModule():
    isolate_test_module()


# The governor's first read after the 10-15 restart (pi-pool.log, 13:50:16Z): kernel normal, no swap file, 0.4 GB compressed.
BOOT = {"kernel": 1, "swap_used": 0, "swap_total": 0, "compressor": 440234147, "ram": 34359738368, "swapouts": 0.0, "source": "feed"}
CPUS = 12
# The governor's reads from 13:50:16Z to 13:52:18Z, 30 s apart, as seconds since boot, with the 1-minute load at each. The coordinator read
# 231 one minute after login and 268 at three; the first read is set low here, the case where the load average has not caught up yet.
BOOT_READS = [(78, 20), (109, 231), (139, 240), (170, 255), (200, 268)]
CFG = dict(base.DEFAULTS, mac_working_max=30)


def reading(load, uptime=None):
    return dict(BOOT, load=load, cpus=CPUS, **({} if uptime is None else {"uptime": uptime}))


class Level(unittest.TestCase):
    def test_load_at_4_a_core_reads_critical_while_memory_is_clean(self):
        self.assertEqual(pressure.level(reading(48)), "critical")
        self.assertEqual(pressure.level(reading(231)), "critical", "13:50Z on 10-15: load 231 on 12 cores")
        self.assertEqual(pressure.level(reading(47.9)), "ok")

    def test_the_first_10_minutes_after_boot_read_critical(self):
        self.assertEqual(pressure.level(reading(5, uptime=78)), "critical", "13:50:16Z, 78 s after boot")
        self.assertEqual(pressure.level(reading(5, uptime=599)), "critical")
        self.assertEqual(pressure.level(reading(5, uptime=600)), "ok")

    def test_a_reading_with_no_load_cores_or_uptime_skips_those_rules(self):
        self.assertEqual(pressure.level(BOOT), "ok", "a Linux read or a record from before this change")
        self.assertEqual(pressure.level(dict(BOOT, load=500, cpus=0)), "ok")


class Replay(unittest.TestCase):
    """Governor reads 30 s apart, with 70 turns queued in 70 trees (pi-pool admitted 70 from 13:50Z to 13:52Z)."""

    def replay(self, reads, start_limit=12):
        t = turns.empty()
        t["pressure"] = {"level": "critical", "at": -1e9, "since": -1e9, "reading": None, "limit": start_limit, "changed": None, "on": True}
        for i in range(70):
            t["queued"][f"s{i}"] = {"tree": f"s{i}", "parent": None, "class": "normal", "since": 0.0, "pid": turns.os.getpid(), "waiter": None}
        limits, working = [], []
        for n, (uptime, load) in enumerate(reads):
            turns.step(t, {}, 30.0 * n, CFG, lambda: reading(load, uptime), trees=lambda: {})
            limits.append(t["pressure"]["limit"])
            working.append(len(turns.in_slots(t["working"])))
        return limits, working

    def test_after_the_10_15_boot_the_limit_stays_at_12_where_the_old_rule_climbed_to_30(self):
        limits, working = self.replay(BOOT_READS)
        self.assertEqual(limits, [12, 12, 12, 12, 12], "the old rule read memory only: 16, 20, 24, 28, 30, as pi-pool.log has it")
        self.assertEqual(max(working), 12)

    def test_a_record_from_before_the_boot_at_the_ok_30_drops_to_12_on_the_first_read(self):
        limits, _ = self.replay(BOOT_READS, start_limit=30)
        self.assertEqual(limits[0], 12)

    def test_a_chat_service_restart_long_after_boot_is_held_by_the_load_alone(self):
        limits, working = self.replay([(9000 + uptime, load) for uptime, load in BOOT_READS])
        self.assertEqual(limits, [16, 12, 12, 12, 12])
        self.assertEqual(max(working), 16, "the first read opened 16 before the load average caught up; none opened after")

    def test_the_limit_reaches_30_two_and_a_half_minutes_after_the_boot_window_and_the_load_clear(self):
        later = [(uptime, 30) for uptime in range(230, 900, 30)]
        limits, _ = self.replay(BOOT_READS + later)
        reads = BOOT_READS + later
        first_ok = next(i for i, (uptime, _) in enumerate(reads) if uptime >= pressure.BOOT_CRITICAL_SEC)
        self.assertEqual(limits[first_ok - 1:first_ok + 5], [12, 16, 20, 24, 28, 30])


if __name__ == "__main__":
    unittest.main()

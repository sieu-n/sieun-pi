"""The spawn gate (pool/spawns.py): go, held, the hysteresis band, first in first out, the budget a read
gives, a gone kernel, and the 10-15 fan-outs at 08:42Z, 09:10Z and 09:30Z.
"""
import json, os, unittest

from fixture_isolation import isolate_test_module
from vend.pool import spawns

ME = os.getpid()
DEAD = 2 ** 22 + 12345


def setUpModule():
    isolate_test_module()


class Gb:
    """A stand-in for pressure.read_workers_gb."""

    def __init__(self, gb):
        self.gb = gb

    def __call__(self):
        return self.gb


def enter(sp, now, gb, name="kid", pid=ME):
    return spawns.enter(sp, now, "parent", name, pid, read=gb)[0]


class Gate(unittest.TestCase):
    def test_a_spawn_under_the_hold_goes_at_once(self):
        sp = spawns.empty()
        self.assertEqual(enter(sp, 0, Gb(12.0)), {"state": "go"})
        self.assertEqual(sp["queue"], [])

    def test_the_hold_starts_at_20_gib_and_ends_at_16(self):
        sp, gb = spawns.empty(), Gb(20.0)
        held = enter(sp, 0, gb, "a")
        self.assertEqual((held["state"], held["position"], held["gb"]), ("held", 1, 20.0))
        gb.gb = 18.0
        self.assertEqual(enter(sp, 30, gb, "b")["state"], "held", "inside the band the hold stays on")
        self.assertEqual(spawns.grant(sp, held["ticket"], 30)[0], "held")
        gb.gb = 16.0
        spawns.refresh(sp, 60, gb)
        self.assertFalse(sp["hold"])
        state, events = spawns.grant(sp, held["ticket"], 60)
        self.assertEqual(state, "go")
        self.assertEqual(events[0][1]["waited_s"], 60)
        sp2, gb2 = spawns.empty(), Gb(18.0)
        self.assertEqual(enter(sp2, 0, gb2)["state"], "go", "18 GiB with no hold before it holds nothing")

    def test_held_spawns_start_in_queue_order(self):
        sp, gb = spawns.empty(), Gb(25.0)
        tickets = [enter(sp, i, gb, f"k{i}")["ticket"] for i in range(5)]
        gb.gb = 19.7
        spawns.refresh(sp, 31, gb)
        self.assertEqual(sp["hold"], True, "19.7 is inside the band, so the hold stays")
        gb.gb = 19.7 - 4
        spawns.refresh(sp, 62, gb)
        self.assertEqual(spawns.grant(sp, tickets[4], 62)[0], "go", "the budget covers all five")
        sp, gb = spawns.empty(), Gb(25.0)
        tickets = [enter(sp, i, gb, f"k{i}")["ticket"] for i in range(5)]
        gb.gb = 15.7
        spawns.refresh(sp, 31, gb)
        sp["granted"] = spawns.budget(sp) - 2
        self.assertEqual(spawns.grant(sp, tickets[2], 31)[0], "held", "third in line with room for two")
        self.assertEqual([spawns.grant(sp, t, 31)[0] for t in tickets[:2]], ["go", "go"])
        self.assertEqual(spawns.grant(sp, tickets[2], 31)[0], "held", "until the next read")

    def test_a_fan_out_fills_the_room_under_20_gib_and_the_rest_wait(self):
        """At 17 GiB a read gives (20 - 17) / 0.15 = 20 starts, so a 26-way fan-out like 08:13Z's starts 20 and holds 6."""
        sp, gb = spawns.empty(), Gb(17.0)
        answers = [enter(sp, 1, gb, f"k{i}")["state"] for i in range(26)]
        self.assertEqual((answers.count("go"), answers.count("held")), (20, 6))
        self.assertEqual(answers[:20], ["go"] * 20)
        self.assertEqual(spawns.grant(sp, sp["queue"][0]["ticket"], 31)[0], "held", "the same read")
        spawns.refresh(sp, 31, gb)
        self.assertEqual(spawns.grant(sp, sp["queue"][0]["ticket"], 31)[0], "go", "the next read")

    def test_a_failed_read_holds_nothing_and_a_gone_kernel_leaves_the_queue(self):
        sp = spawns.empty()
        self.assertEqual(enter(sp, 0, Gb(None)), {"state": "go"})
        sp, gb = spawns.empty(), Gb(30.0)
        enter(sp, 0, gb, "lost", pid=DEAD)
        live = enter(sp, 1, gb, "live")
        self.assertEqual([e["name"] for e in sp["queue"]], ["live"])
        self.assertEqual(live["position"], 1)


class Fanouts1015(unittest.TestCase):
    """The minutes around the three 10-15 fan-outs, one row a feed minute: Prime's workers' GiB and live sessions.
    Each minute's new live sessions ask the gate after one read; a held spawn is modeled as SESSION_GB the workers do
    not hold yet."""

    def replay(self, rows):
        sp, prev, peak, starts, began = spawns.empty(), rows[0]["live"], 0.0, 0, None
        for i, row in enumerate(rows):
            now = i * 60.0
            gb = lambda row=row: round(row["workers_gb"] - spawns.SESSION_GB * len(sp["queue"]), 2)
            spawns.refresh(sp, now, gb)
            for e in list(sp["queue"]):
                if spawns.grant(sp, e["ticket"], now)[0] != "go":
                    break
                starts += 1
            for k in range(max(0, row["live"] - prev)):
                if enter(sp, now, gb, f"k{i}-{k}")["state"] == "held" and began is None:
                    began = row["at"]
            prev = row["live"]
            peak = max(peak, gb())
        return {"held": len(sp["queue"]), "first_held": began, "peak": peak, "observed": max(r["workers_gb"] for r in rows)}

    def setUp(self):
        with open(os.path.join(os.path.dirname(__file__), "fanouts_1015.json")) as f:
            self.windows = json.load(f)["windows"]

    def test_0842_the_gate_holds_from_the_first_minute_over_20_gib(self):
        got = self.replay(self.windows["0842"])
        self.assertEqual(got["first_held"], "2026-10-15T08:41")
        self.assertEqual(got["observed"], 24.03)
        self.assertLess(got["peak"], spawns.HOLD_ON_GB, "the modeled workers stay under the hold line")

    def test_0910_and_0930_every_new_child_waits_while_the_workers_hold_over_20_gib(self):
        for key, first, held in (("0910", "2026-10-15T09:09", 20), ("0930", "2026-10-15T09:30", 26)):
            got = self.replay(self.windows[key])
            self.assertEqual((got["first_held"], got["held"]), (first, held), key)


if __name__ == "__main__":
    unittest.main()

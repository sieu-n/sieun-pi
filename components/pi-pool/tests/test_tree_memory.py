"""The per-tree memory hold (pool/turns.py with pressure.read_tree_memory): while memory
pressure is high or critical, a tree the chat service lists in ~/.cache/virev/tree-memory.json
over a quarter of RAM gets no new turns but its root session's own, until it leaves the file.
"""
import calendar, json, os, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE  # noqa: F401, puts vend on sys.path
from test_turns import GB, RAM, ask_args, fill
from vend.pool import base, pressure, turns


def setUpModule():
    isolate_test_module()


def utc(text):
    return calendar.timegm(time.strptime("2026-10-15 " + text, "%Y-%m-%d %H:%M:%S"))


SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2"
SEARCH = "01a13ce0-9f35-763b-a2c8-fe74c2e7fde4"
# 10-15 00:42Z: the feed said warn with 5,790.5 swapouts a second, under SWAPOUTS_CRITICAL, so the
# level is high; at 00:48Z it counted 16,891.7, so critical. Swap and compressor sizes stand below
# their critical shares.
HIGH_0042 = {"kernel": 2, "swap_used": 20 * GB, "swap_total": 46170898432, "compressor": 8 * GB, "ram": RAM, "swapouts": 5790.5}
CRITICAL_0048 = dict(HIGH_0042, swapouts=16891.7)
CALM = dict(HIGH_0042, kernel=1, swapouts=0)
# The VP of SEO tree at 00:42Z (16.7 GiB), with old_analysis.py (pid 77405), whose footprint
# peaked at 30.26 GB.
SEO_OVER = {"root": SEO, "tree": "VP of SEO", "gb": 16.7, "pid": 77405, "process_gb": 28.18, "command": "python3 old_analysis.py"}
SEARCH_OVER = {"root": SEARCH, "tree": "search visits grow SEO guy", "gb": 9.29, "pid": 70001, "process_gb": 8.5, "command": "python3 visits.py"}


def sample(ts, *over):
    return {"v": 1, "ts": ts, "ram_gb": 32.0, "share": 0.25, "over": list(over)}


class Calls:
    """A stand-in for pressure.read or pressure.read_tree_memory that counts its calls."""

    def __init__(self, value):
        self.value, self.calls = value, 0

    def __call__(self):
        self.calls += 1
        return self.value


class Reader(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(prefix="pi-pool-tree-memory-"), "tree-memory.json")

    def write(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def test_a_fresh_sample_gives_its_over_records_by_root(self):
        self.write(json.dumps(sample("2026-10-15T00:42:00.123Z", SEO_OVER)))
        self.assertEqual(pressure.read_tree_memory(self.path, now=utc("00:42:30")), {SEO: SEO_OVER})
        self.write(json.dumps(sample("2026-10-15T00:42:00+00:00")))
        self.assertEqual(pressure.read_tree_memory(self.path, now=utc("00:42:30")), {}, "over is [] when no tree is over")

    def test_a_sample_180_s_old_is_stale(self):
        self.write(json.dumps(sample("2026-10-15T00:11:00Z", SEARCH_OVER)))
        self.assertEqual(set(pressure.read_tree_memory(self.path, now=utc("00:13:59"))), {SEARCH})
        self.assertEqual(pressure.read_tree_memory(self.path, now=utc("00:14:00")), {}, "three missed one-minute writes")
        self.assertEqual(pressure.TREE_MEMORY_FRESH_SEC, 180)

    def test_a_missing_or_malformed_sample_holds_nothing(self):
        now = utc("00:42:30")
        self.assertEqual(pressure.read_tree_memory(self.path + ".absent", now=now), {})
        good = sample("2026-10-15T00:42:00Z", SEO_OVER)
        bad = [dict(good, v=2), dict(good, ts=None), dict(good, ts="yesterday"), dict(good, over=None), dict(good, over={"root": SEO})]
        for text in ["", "{", "[]", "null"] + [json.dumps(b) for b in bad]:
            self.write(text)
            self.assertEqual(pressure.read_tree_memory(self.path, now=now), {}, text)
        self.write(json.dumps(sample("2026-10-15T00:42:00Z", SEO_OVER, {"tree": "no root"}, {"root": ""}, "x")))
        self.assertEqual(set(pressure.read_tree_memory(self.path, now=now)), {SEO}, "records with no root are skipped")


class Hold(unittest.TestCase):
    CFG = dict(base.DEFAULTS, mac_working_max=30)
    SESSIONS = {SEO: {"priority": "high"}, SEARCH: {"priority": "normal"}, "ops": {"priority": "normal"}}

    def ask(self, t, session, now, read, trees, **kw):
        return turns.ask(t, self.SESSIONS, ask_args(session, **kw), now, self.CFG, read=read, trees=trees)

    def test_the_seo_trees_child_is_held_past_hold_max_s_while_its_root_an_owner_turn_and_another_tree_run(self):
        """10-15 00:40-00:53Z: the VP of SEO tree held 16 to 25.5 GiB and the Mac swapped out up to
        25,873 pages a second. Its job's turns wait whatever their class; its root's turn runs so the
        chat can read the notice and stop the job."""
        t, read, trees = turns.empty(), Calls(HIGH_0042), Calls({SEO: SEO_OVER})
        fill(t, 4)
        start = utc("00:42:00")
        answer, events = self.ask(t, "seo-job", start, read, trees, tree=SEO, parent=SEO, klass="high")[1:]
        self.assertEqual((t["pressure"]["level"], answer["state"]), ("high", "queued"), "5 of 16 in use and still held")
        self.assertIn(("tree_memory_held", {"root": SEO, "at": start, "level": "high", "tree": "VP of SEO", "gb": 16.7,
                                            "pid": 77405, "process_gb": 28.18}), events)
        queued = [f for e, f in events if e == "turn_queued"][0]
        self.assertEqual((queued["held"], queued["memory_held"]), (True, True))
        self.assertEqual(self.ask(t, SEO, start + 1, read, trees, tree=SEO)[1]["state"], "admitted", "the root session's own turn")
        self.assertEqual(self.ask(t, "seo-job-2", start + 2, read, trees, tree=SEO, parent=SEO, klass="low")[1]["state"], "queued",
                         "no borrow on the in-flight root's lent slot")
        turns.mark_owner(t, "seo-owner", start + 3, 1800)
        self.assertEqual(self.ask(t, "seo-owner", start + 4, read, trees, tree=SEO, parent=SEO)[1]["kind"], "owner", "an owner turn never waits")
        self.assertEqual(self.ask(t, "ops-job", start + 5, read, trees, tree="ops", parent="ops")[1]["state"], "admitted",
                         "another tree's normal turn")
        for now in range(start + 30, start + turns.HOLD_MAX_S + 120, 30):
            self.assertEqual(turns.step(t, self.SESSIONS, now, self.CFG, read, trees)[2], [])
        self.assertEqual(sorted(t["queued"]), ["seo-job", "seo-job-2"], "past HOLD_MAX_S and with free slots")
        p = turns.view(t, now, self.CFG, self.SESSIONS)["pressure"]
        self.assertEqual((p["memory_trees"], p["held"]), ([SEO], 2))
        read.value = CRITICAL_0048
        admitted, events = turns.step(t, self.SESSIONS, now + 30, self.CFG, read, trees)[2:]
        self.assertEqual((admitted, [e for e, _ in events], t["pressure"]["level"]), ([], ["pressure_level"], "critical"),
                         "still held at critical, and no new hold line")

    def test_the_file_is_read_once_a_governor_read_and_not_at_level_ok(self):
        t, read, trees = turns.empty(), Calls(HIGH_0042), Calls({SEO: SEO_OVER})
        for now in range(0, 30, 3):
            self.ask(t, f"s{now}", now, read, trees, tree=SEO, parent=SEO)
        self.assertEqual((read.calls, trees.calls), (1, 1))
        read.value = CALM
        turns.step(t, self.SESSIONS, 31, self.CFG, read, trees)
        self.assertEqual((trees.calls, t["pressure"]["memory_trees"]), (1, []))

    def test_the_search_tree_is_held_while_listed_and_runs_once_the_file_drops_it_or_goes_stale(self):
        """09:11 KST on 10-15 (00:11Z): the search visits grow SEO guy tree read 9.29 GiB with 11,824
        swapouts a second, 8.09 GiB at 00:12 and 2.16 GiB at 00:13, and its script ended on its own."""
        path = os.path.join(tempfile.mkdtemp(prefix="pi-pool-tree-memory-"), "tree-memory.json")
        clock = [utc("00:11:00")]
        trees = lambda: pressure.read_tree_memory(path, now=clock[0])

        def write(ts, *over):
            with open(path, "w") as f:
                json.dump(sample("2026-10-15T" + ts + "Z", *over), f)

        def run(now, reading=HIGH_0042):
            clock[0] = now
            t = turns.empty()
            fill(t, 4)
            answer = self.ask(t, "search-job", now, lambda: reading, trees, tree=SEARCH, parent=SEARCH)[1]
            return t, answer["state"]

        write("00:11:00", dict(SEARCH_OVER, gb=9.29))
        t, state = run(utc("00:11:00"))
        self.assertEqual((state, t["pressure"]["memory_trees"]), ("queued", [SEARCH]))
        write("00:12:00", dict(SEARCH_OVER, gb=8.09))
        clock[0] = utc("00:12:00")
        self.assertEqual(turns.step(t, self.SESSIONS, utc("00:12:00"), self.CFG, lambda: HIGH_0042, trees)[2], [], "held while listed")
        write("00:13:00")
        clock[0] = utc("00:13:00")
        changed, gone, admitted, events = turns.step(t, self.SESSIONS, utc("00:13:00"), self.CFG, lambda: HIGH_0042, trees)
        self.assertEqual(admitted, [("search-job", "slot")], "the file dropped the tree")
        self.assertIn(("tree_memory_released", {"root": SEARCH, "at": utc("00:13:00"), "why": "left tree-memory.json"}), events)

        write("00:11:00", dict(SEARCH_OVER, gb=9.29))
        t, state = run(utc("00:13:59"))
        self.assertEqual(state, "queued", "179 s old")
        clock[0] = utc("00:14:29")
        self.assertEqual(turns.step(t, self.SESSIONS, utc("00:14:29"), self.CFG, lambda: HIGH_0042, trees)[2], [("search-job", "slot")],
                         "the next governor read finds the file stale and holds nothing")

        t, state = run(utc("00:11:00"), CALM)
        self.assertEqual((state, t["pressure"]["memory_trees"]), ("admitted", []), "nothing is held at level ok")

    def test_the_level_returning_to_ok_releases_the_tree_and_logs_it(self):
        t, read, trees = turns.empty(), Calls(HIGH_0042), Calls({SEO: SEO_OVER})
        self.assertEqual(self.ask(t, "seo-job", 0, read, trees, tree=SEO, parent=SEO)[1]["state"], "queued")
        read.value = CALM
        changed, gone, admitted, events = turns.step(t, self.SESSIONS, 31, self.CFG, read, trees)
        self.assertEqual(admitted, [("seo-job", "slot")])
        self.assertIn(("tree_memory_released", {"root": SEO, "at": 31, "why": "level ok"}), events)
        self.assertEqual(turns.view(t, 31, self.CFG, self.SESSIONS)["pressure"]["memory_trees"], [])

    def test_the_governor_off_switch_holds_nothing(self):
        t, trees = turns.empty(), Calls({SEO: SEO_OVER})
        off = dict(self.CFG, memory_governor_on=0)
        answer = turns.ask(t, self.SESSIONS, ask_args("seo-job", tree=SEO, parent=SEO), 0, off, read=lambda: CRITICAL_0048, trees=trees)[1]
        self.assertEqual((answer["state"], trees.calls, t["pressure"]["memory_trees"]), ("admitted", 0, []))


if __name__ == "__main__":
    unittest.main()

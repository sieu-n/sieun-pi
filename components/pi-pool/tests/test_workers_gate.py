"""The workers gate (pool/turns.py WORKERS_GB_MAX): background turns start only while the Prime workers hold under 16 GiB, read at each
admit; owner turns and prod turns never wait. Replays the queue classes of 22:00Z on 10-15, when 29 root workers held 20.24 GiB by
phys_footprint (6 chats mid-turn 10.23, 5 jobs mid-turn 1.82, 3 queued jobs 1.24, a queued chat 0.86) and the hour read 56% usable with
21 harness minutes, while the slot limit of 12 let 14 to 24 turns work."""
import os, unittest, unittest.mock

from fixture_isolation import isolate_test_module
import test_core  # noqa: F401, puts vend on the path
from vend.pool import base, turns


def setUpModule():
    isolate_test_module()


ME = os.getpid()
OK = {"kernel": 1, "swap_used": 0, "swap_total": 0, "compressor": 0, "ram": 32 * 2 ** 30}
CFG = dict(base.DEFAULTS, mac_working_max=12)
CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048"


def at_2200():
    """The pi-pool queue at 22:00Z on 10-15 as the worker classes read it: 6 chats and 6 jobs mid-turn, and 5 turns queued."""
    t = turns.empty()
    for i, chat in enumerate(["harness", "crawler", "ops", "launch", "frontend", "slackgreen"]):
        t["working"][f"chat-{chat}"] = {"tree": f"chat-{chat}", "parent": None, "class": "high", "since": 0, "pid": ME, "kind": "slot", "lease_until": 10 ** 9}
    for i in range(6):
        t["working"][f"job{i}"] = {"tree": f"job{i}", "parent": None, "class": "normal", "since": 0, "pid": ME, "kind": "slot", "lease_until": 10 ** 9}
    for i, s in enumerate(["meta-ads", "langfuse", "golden", "fix-launch", "chat-ci"]):
        t["queued"][s] = {"tree": s, "parent": None, "class": "high" if s == "chat-ci" else "normal", "since": 100 + i, "pid": ME}
    return t


def step(t, now, gb):
    return turns.step(t, {}, now, dict(CFG, mac_working_max=30), read=lambda: OK, trees=lambda: {}, workers=lambda: gb)


class WorkersGate(unittest.TestCase):
    def test_at_20_24_gib_no_background_turn_starts_though_18_slots_are_free(self):
        t = at_2200()
        changed, gone, admitted, events = step(t, 200, 20.24)
        self.assertEqual(admitted, [])
        self.assertEqual(len(t["queued"]), 5)
        self.assertIn(("workers_held", {"gb": 20.24, "at": 200, "queued": 5, "working": 12}), events)
        self.assertTrue(t["pressure"]["workers_full"])

    def test_an_owner_turn_and_a_prod_turn_start_at_20_24_gib(self):
        t = at_2200()
        t["queued"][CRAWLER] = {"tree": CRAWLER, "parent": None, "class": "normal", "since": 150, "pid": ME}
        t["prod"] = {"at": 200, "trees": {CRAWLER: "the prod alert KubePodCrashLooping"}, "sessions": {}}
        with unittest.mock.patch.object(turns, "prod_watch", lambda turns_, now, cfg, read=None: (False, [])):
            admitted = step(t, 200, 20.24)[2]
        self.assertEqual(admitted, [(CRAWLER, "prod")])
        turns.mark_owner(t, "chat-api", 201, 1800)
        args = {"session": "chat-api", "tree": "chat-api", "parent": None, "class": None, "pid": ME, "wait": False, "renew": False}
        answer = turns.ask(t, {}, args, 201, dict(CFG, mac_working_max=30), read=lambda: OK, trees=lambda: {}, workers=lambda: 20.24)[1]
        self.assertEqual((answer["state"], answer["kind"]), ("admitted", "owner"))

    def test_a_new_background_ask_queues_over_the_line_and_starts_when_a_read_falls_under_it(self):
        t = at_2200()
        args = {"session": "new-job", "tree": "new-job", "parent": None, "class": None, "pid": ME, "wait": False, "renew": False}
        answer = turns.ask(t, {}, args, 200, dict(CFG, mac_working_max=30), read=lambda: OK, trees=lambda: {}, workers=lambda: 16.0)[1]
        self.assertEqual(answer["state"], "queued")
        # The workers read 14.64 GiB at 22:4xZ: 14.64, 15.00, 15.36 and 15.72 are under 16, so 4 start in line order.
        changed, gone, admitted, events = step(t, 230, 14.64)
        self.assertEqual([s for s, _ in admitted], ["meta-ads", "langfuse", "golden", "fix-launch"])
        self.assertIn("workers_released", [e for e, _ in events])

    def test_with_no_background_turn_working_one_starts_whatever_the_workers_hold(self):
        t = at_2200()
        t["working"] = {}
        self.assertEqual([s for s, _ in step(t, 200, 20.24)[2]], ["meta-ads"])
        self.assertEqual(step(t, 201, 20.24)[2], [])

    def test_a_failed_read_holds_nothing(self):
        t = at_2200()
        self.assertEqual(len(step(t, 200, None)[2]), 5)

    def test_room(self):
        self.assertEqual(turns.workers_room(15.99, {"a": {"kind": "slot"}}), 1)
        self.assertEqual(turns.workers_room(16.0, {"a": {"kind": "slot"}}), 0)
        self.assertEqual(turns.workers_room(16.0, {"a": {"kind": "owner"}, "b": {"kind": "prod"}}), 1)
        self.assertIsNone(turns.workers_room(None, {}))


if __name__ == "__main__":
    unittest.main()

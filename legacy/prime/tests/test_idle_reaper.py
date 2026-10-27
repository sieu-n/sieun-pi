import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("reaper", Path(__file__).resolve().parents[3] / "legacy/prime/idle-reaper/reaper.py")
reaper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reaper)

BIN = "/Users/x/.local/share/prime-agent/releases/r1/prime-agent"


def proc(pid, ppid, args, age=3600, tty="??"):
    return {"pid": pid, "ppid": ppid, "age": age, "rss_kb": 102400, "tty": tty, "args": args}


def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def session(pid, minutes, **flags):
    return {"workerPid": pid, "sessionName": f"s{pid}", "activity": "idle", "lastActivityAt": ago(minutes), **flags}


class PlanTest(unittest.TestCase):
    def setUp(self):
        worker = lambda pid, age=3600: proc(pid, 10, f"{BIN} --mode daemon --daemon-socket /tmp/p/worker-a-{pid}.sock", age)
        self.table = {p["pid"]: p for p in [
            proc(10, 1, f"{BIN} /$bunfs/root/prime-agent --mode daemon --daemon-socket /tmp/p/daemon.sock"),
            worker(20), worker(21), worker(22), worker(23), worker(24, age=30), worker(25),
            proc(30, 10, f"{BIN} --version", age=200), proc(31, 10, f"{BIN} --version", age=60),
            proc(32, 10, f"{BIN} --version", age=900),
            proc(40, 99, "prime-agent", tty="ttys004"),
            proc(50, 25, "/Users/x/.prime/agent/kernel-venv/bin/python"),
            proc(51, 50, "/bin/bash -c exec 9>&0 read -r _prime_agent_gate sleep 540"),
        ]}
        self.sessions = [
            session(20, 30), session(20, 20),
            session(21, 30), session(21, 5),
            session(22, 30, isRunningTools=True),
            session(23, 30, hasActiveHeartbeat=True),
            session(24, 30),
            session(25, 30),
        ]

    def test_plan(self):
        result = reaper.plan(self.table, self.sessions, 10, 2)
        self.assertEqual(result["daemon"], 10)
        self.assertEqual(sorted(item["pid"] for item in result["kill"]), [20, 30, 32])
        reasons = {item["pid"]: item["reason"] for item in result["keep"]}
        self.assertIn("last activity", reasons[21])
        self.assertIn("isRunningTools", reasons[22])
        self.assertIn("hasActiveHeartbeat", reasons[23])
        self.assertIn("started", reasons[24])
        self.assertIn("bash pid 51", reasons[25])
        self.assertNotIn(10, [item["pid"] for item in result["kill"] + result["keep"]])
        self.assertNotIn(40, [item["pid"] for item in result["kill"] + result["keep"]])

    def test_catalog_is_kept(self):
        # pid 32 is the daemon catalog: a `--version` child with PRIME_AGENT_INTERNAL_DAEMON_CATALOG=1 that lives as long as the daemon.
        result = reaper.plan(self.table, self.sessions, 10, 2, {32})
        self.assertEqual(sorted(item["pid"] for item in result["kill"]), [20, 30])
        self.assertEqual({item["pid"]: item["kind"] for item in result["keep"]}[32], "catalog")
        self.assertEqual([item["ids"] for item in result["kill"] if item["pid"] == 20], [[None, None]])
        unknown = reaper.plan(self.table, self.sessions, 10, 2, None)
        self.assertEqual(sorted(item["pid"] for item in unknown["kill"]), [20])

    def test_etime(self):
        self.assertEqual(reaper.etime_seconds("01:05"), 65)
        self.assertEqual(reaper.etime_seconds("1-02:00:01"), 93601)


if __name__ == "__main__":
    unittest.main()

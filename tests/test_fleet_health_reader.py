"""10-27 hello fix: fleet_health read and sent through prime-agent's CLI, which waits a fixed 3 s for the daemon's hello, while probes on
us-metal02 got the hello after 3 to 7 s on 10-22. It now goes through sieun-pi's daemon reader (daemon-cli.mjs), which waits 30 s."""
import json, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills"))
from skills.prime_agent import fleet_health  # noqa: E402


class ReaderCalls(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def run(cmd, timeout=120):
            self.calls.append(cmd)
            return 0, json.dumps({"sessions": [{"sessionId": "s1", "id": "a1"}]})
        patcher = mock.patch.object(fleet_health, "_run", run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def reader(self, with_tsx=True):
        root = Path(tempfile.mkdtemp()) / "components" / "user-history"
        (root / "src").mkdir(parents=True)
        (root / "src" / "daemon-cli.mjs").write_text("")
        if with_tsx:
            (root / "node_modules" / "tsx").mkdir(parents=True)
        return mock.patch.object(fleet_health, "DAEMON_CLI", root / "src" / "daemon-cli.mjs")

    def test_the_list_goes_through_the_reader(self):
        with self.reader(), mock.patch.object(fleet_health.shutil, "which", lambda name: "/usr/bin/node"):
            self.assertEqual(list(fleet_health.list_sessions()), ["s1"])
        self.assertEqual(self.calls[0][0], "/usr/bin/node")
        self.assertTrue(self.calls[0][1].endswith("daemon-cli.mjs"))
        self.assertEqual(self.calls[0][2:], ["list", "--all"])

    def test_a_send_goes_through_the_reader(self):
        with self.reader(), mock.patch.object(fleet_health.shutil, "which", lambda name: "/usr/bin/node"):
            fleet_health._daemon("send", "s1", "continue")
        self.assertEqual(self.calls[0][2:], ["send", "s1", "continue"])

    def test_a_checkout_without_tsx_keeps_the_cli(self):
        with self.reader(with_tsx=False), mock.patch.object(fleet_health.shutil, "which", lambda name: "/usr/bin/node"):
            fleet_health.list_sessions()
        self.assertEqual(self.calls[0], ["prime-agent", "list", "--json", "--all"])


if __name__ == "__main__":
    unittest.main()

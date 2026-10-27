"""10-27: followUpMode "all" in config/settings.shared.json reaches settings.json, but Prime reads the queue modes only when it loads a session, so
a chat that stays loaded kept one follow-up per run. prime-sync now sets a changed mode on every loaded session once, through daemon-cli.mjs.
Run: python3 -B -m unittest tests/test_prime_sync_modes.py"""
import importlib.util, json, os, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

SYNC = Path(__file__).resolve().parents[1] / "components/prime-sync/sync.py"


def load(share):
    with mock.patch.dict(os.environ, {"PRIME_SYNC_HOME": str(share)}):
        spec = importlib.util.spec_from_file_location("prime_sync_modes", SYNC)
        sync = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sync)
    return sync


class PushModes(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.share = self.dir / "share"
        self.share.mkdir()
        self.checkout = self.dir / "checkout"
        (self.checkout / "config").mkdir(parents=True)
        (self.checkout / "config/settings.shared.json").write_text(json.dumps({"steeringMode": "all", "followUpMode": "all", "defaultThinkingLevel": "high"}))
        self.calls = self.dir / "calls.jsonl"
        self.reader = self.dir / "reader.py"
        self.reader.write_text(
            "import json, os, sys\n"
            f"open({str(self.calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if os.environ.get('READER_FAILS'): sys.stderr.write('Timed out after 30000ms'); sys.exit(1)\n"
            "print(json.dumps({'sessions': 3, 'set': 3, 'failed': []}))\n")
        self.sync = load(self.share)
        self.sync.daemon_reader = lambda: [sys.executable, str(self.reader)]

    def calls_made(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_a_new_mode_goes_to_the_loaded_sessions_once(self):
        self.assertEqual(self.sync.push_modes(self.checkout), ["set steeringMode all, followUpMode all on 3 of 3 loaded sessions"])
        self.assertEqual(self.calls_made(), [["modes", "steeringMode=all", "followUpMode=all"]])
        self.assertEqual(self.sync.push_modes(self.checkout), [])
        self.assertEqual(len(self.calls_made()), 1)

    def test_only_the_changed_mode_goes_out(self):
        (self.share / "modes.json").write_text(json.dumps({"steeringMode": "all", "followUpMode": "one-at-a-time"}))
        self.sync.push_modes(self.checkout)
        self.assertEqual(self.calls_made(), [["modes", "followUpMode=all"]])

    def test_a_failed_push_is_tried_again_next_run(self):
        with mock.patch.dict(os.environ, {"READER_FAILS": "1"}):
            with self.assertRaises(RuntimeError):
                self.sync.push_modes(self.checkout)
        self.assertFalse((self.share / "modes.json").exists())
        self.sync.push_modes(self.checkout)
        self.assertEqual(json.loads((self.share / "modes.json").read_text()), {"steeringMode": "all", "followUpMode": "all"})

    def test_the_shared_settings_batch_follow_ups(self):
        shared = json.loads((SYNC.parents[2] / "config/settings.shared.json").read_text())
        self.assertEqual((shared["steeringMode"], shared["followUpMode"]), ("all", "all"))


if __name__ == "__main__":
    unittest.main()

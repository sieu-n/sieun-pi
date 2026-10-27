import json
from pathlib import Path
import subprocess
import unittest

from fixture_isolation import isolate_test_module
from prime_extension import EXTENSION


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent


class SessionStart(unittest.TestCase):
    def test_start_does_not_wait_for_the_cli_and_the_first_model_call_waits_for_the_model_record(self):
        """On 10-20 the awaited start calls held each Mac create about 1.1 s; the daemon answers a create after session_start."""
        result = subprocess.run(["node", str(TESTS / "start_driver.mjs"), str(EXTENSION)], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        events = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(events[:2], ["cli adopt-logins", "session_start done"], events)
        self.assertLess(events.index("cli model"), events.index("cli admit"), events)
        self.assertEqual(events[-1], "context done", events)


if __name__ == "__main__":
    unittest.main()

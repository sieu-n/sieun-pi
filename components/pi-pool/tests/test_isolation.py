import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from fixture_isolation import GUARD_DIR, isolate_test_module


SOURCE = Path(__file__).resolve().parents[1]


def setUpModule():
    isolate_test_module()


class IsolationSentinels(unittest.TestCase):
    def probe(self, runtime, source, expected):
        with tempfile.TemporaryDirectory(prefix="pi-pool-guard-probe-") as temporary:
            root = Path(temporary)
            marker = root / "violations.jsonl"
            script = root / ("probe.py" if runtime == "python" else "probe.mjs")
            script.write_text(source)
            env = {**os.environ, "PI_POOL_TEST_ISOLATION_LOG": str(marker),
                   "PYTHONPATH": str(GUARD_DIR), "PYTHONDONTWRITEBYTECODE": "1"}
            command = ([sys.executable, "-B", str(script)] if runtime == "python" else
                       ["node", "--import", str(SOURCE / "tests/native/isolation.mjs"), str(script)])
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(expected, result.stderr)
            violations = [json.loads(line)["violation"] for line in marker.read_text().splitlines()]
            self.assertEqual(len(violations), 1)
            self.assertIn(expected, violations[0])

    def test_python_denies_keychain_subprocess(self):
        self.probe("python", 'import subprocess\nsubprocess.run(["/usr/bin/security", "help"])',
                   "macOS Keychain command denied")

    def test_python_denies_remote_url(self):
        self.probe("python", 'import urllib.request\nurllib.request.urlopen("https://example.invalid/")',
                   "network access denied")

    def test_node_denies_keychain_subprocess(self):
        self.probe("node", 'import { execFileSync } from "node:child_process"; execFileSync("/usr/bin/security", ["help"]);',
                   "macOS Keychain command denied")

    def test_node_denies_remote_socket(self):
        self.probe("node", 'import { connect } from "node:net"; connect({ host: "192.0.2.1", port: 9 });',
                   "network access denied")

    def test_node_denies_remote_fetch(self):
        self.probe("node", 'await fetch("https://example.invalid/");', "network access denied")

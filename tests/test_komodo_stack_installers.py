"""On Linux each sieun-pi installer writes and enables no systemd user unit and restarts its Komodo container of Stack box-sieun-pi
(11-22: a unit beside the container starts a second copy, as sieun-pi-wiki.service did on :5176 on 11-21)."""
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG.$(basename "$0")"
case "$(basename "$0") $1" in
  "docker inspect") echo false ;;
esac
exit 0
"""

NODE = shutil.which("node") or sys.executable
INSTALLERS = [
    # name, argv, the Stack service it restarts (None for a job a Procedure starts)
    ("meilisearch", [NODE, "scripts/install-meilisearch.mjs"], "meilisearch"),
    ("pi-history", [NODE, "packages/pi-history/install.mjs", "--ref", "HEAD"], "pi-history"),
    ("harness-feed", [NODE, "components/harness-feed/install.mjs", "--ref", "HEAD"], "harness-feed"),
    ("usage-feed", [sys.executable, "-B", "legacy/prime/usage-feed/install.py", "--ref", "HEAD"], "usage-feed"),
    ("session-archive", [sys.executable, "-B", "components/session-archive/install.py", "--ref", "HEAD"], None),
]


def meilisearch_binary():
    version = re.search(r'const VERSION = "([^"]+)"', (REPO / "scripts/install-meilisearch.mjs").read_text()).group(1)
    return Path.home() / f".local/opt/meilisearch/v{version}/meilisearch", version


@unittest.skipUnless(platform.system() == "Linux" and shutil.which("node"), "the Komodo branch runs on Linux, and the Node installers need node")
class InstallersOnLinux(unittest.TestCase):
    def install(self, name, argv):
        home = Path(tempfile.mkdtemp(prefix=f"komodo-{name}-"))
        self.addCleanup(shutil.rmtree, home, True)
        fakes = home / "fake-bin"
        fakes.mkdir()
        for tool in ("docker", "systemctl"):
            (fakes / tool).write_text(FAKE)
            (fakes / tool).chmod(0o755)
        (home / ".local/node/bin").mkdir(parents=True)
        (home / ".local/node/bin/node").symlink_to(NODE)
        if name == "meilisearch":
            binary, version = meilisearch_binary()
            if not binary.exists():
                self.skipTest(f"{binary} is not on this box, and the installer downloads it otherwise")
            (home / f".local/opt/meilisearch/v{version}").mkdir(parents=True)
            (home / f".local/opt/meilisearch/v{version}/meilisearch").symlink_to(binary)
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(HOME=str(home), PATH=f"{fakes}:{env['PATH']}", FAKE_LOG=str(home / "calls"))
        done = subprocess.run(argv, cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
        read = lambda tool: (home / f"calls.{tool}").read_text().splitlines() if (home / f"calls.{tool}").exists() else []
        units = home / ".config/systemd/user"
        return done, sorted(p.name for p in units.iterdir()) if units.exists() else [], read("systemctl"), read("docker")

    def test_linux_gets_no_unit_and_a_restarted_container(self):
        for name, argv, service in INSTALLERS:
            with self.subTest(name):
                done, units, systemctl, docker = self.install(name, argv)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(units, [], done.stdout + done.stderr)
                self.assertEqual(systemctl, [])
                self.assertEqual([line for line in docker if line.startswith("restart")], [f"restart box-sieun-pi-{service}-1"] if service else [])

    def test_the_scratch_reaper_installer_refuses_linux(self):
        done, units, systemctl, _ = self.install("scratch-reaper", [sys.executable, "-B", "components/scratch-reaper/install.py"])
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("m02-scratch-reaper", done.stderr)
        self.assertEqual((units, systemctl), ([], []))


if __name__ == "__main__":
    unittest.main()

"""Each sieun-pi installer writes and enables no systemd user unit on a box that runs the Komodo Stack box-sieun-pi, and keeps its unit on a
box without it (11-22: a later install would have started a second copy beside the container, as sieun-pi-wiki.service did on 11-21)."""
import importlib.util
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("komodo_stack", REPO / "deploy/linux/komodo_stack.py")
komodo_stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(komodo_stack)

FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG.$(basename "$0")"
case "$(basename "$0") $1" in
  "docker ps") [ -n "$FAKE_STACK" ] && echo c285685a37f0 ;;
  "docker inspect") echo false ;;
  "systemctl is-active") echo failed ;;
esac
exit 0
"""

NODE = shutil.which("node") or sys.executable
INSTALLERS = [
    # name, argv, the unit files it writes without the Stack, the Stack service it restarts (None for a job a Procedure starts)
    ("meilisearch", [NODE, "scripts/install-meilisearch.mjs"], ["meilisearch.service", "meilisearch-warm.timer"], "meilisearch"),
    ("pi-history", [NODE, "packages/pi-history/install.mjs", "--ref", "HEAD"], ["pi-history.service"], "pi-history"),
    ("harness-feed", [NODE, "components/harness-feed/install.mjs", "--ref", "HEAD"], ["harness-feed.service"], "harness-feed"),
    ("usage-feed", [sys.executable, "-B", "legacy/prime/usage-feed/install.py", "--ref", "HEAD"], ["usage-feed.service"], "usage-feed"),
    ("scratch-reaper", [sys.executable, "-B", "components/scratch-reaper/install.py"], ["scratch-reaper.timer"], None),
    ("session-archive", [sys.executable, "-B", "components/session-archive/install.py", "--ref", "HEAD"], ["session-archive.timer"], None),
]


def meilisearch_binary():
    version = re.search(r'const VERSION = "([^"]+)"', (REPO / "scripts/install-meilisearch.mjs").read_text()).group(1)
    return Path.home() / f".local/opt/meilisearch/v{version}/meilisearch", version


@unittest.skipUnless(platform.system() == "Linux" and shutil.which("node"), "the systemd branch runs on Linux, and the Node installers need node")
class InstallersOnAStackBox(unittest.TestCase):
    def install(self, name, argv, stack):
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
        env.update(HOME=str(home), PATH=f"{fakes}:{env['PATH']}", FAKE_LOG=str(home / "calls"), FAKE_STACK="1" if stack else "")
        done = subprocess.run(argv, cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
        read = lambda tool: (home / f"calls.{tool}").read_text().splitlines() if (home / f"calls.{tool}").exists() else []
        units = home / ".config/systemd/user"
        return done, sorted(p.name for p in units.iterdir()) if units.exists() else [], read("systemctl"), read("docker")

    def test_a_stack_box_gets_no_unit_and_a_restarted_container(self):
        for name, argv, unit_files, service in INSTALLERS:
            with self.subTest(name):
                done, units, systemctl, docker = self.install(name, argv, stack=True)
                self.assertEqual(units, [], done.stdout + done.stderr)
                self.assertEqual([line for line in systemctl if re.match(r"--user (enable|start|restart)\b", line)], [])
                self.assertTrue(any(line.startswith("--user disable --now") and unit_files[0] in line for line in systemctl), systemctl)
                if service:
                    self.assertIn(f"restart box-sieun-pi-{service}-1", docker)

    def test_a_box_without_the_stack_keeps_its_units(self):
        for name, argv, unit_files, _ in INSTALLERS:
            with self.subTest(name):
                done, units, systemctl, docker = self.install(name, argv, stack=False)
                for unit in unit_files:
                    self.assertIn(unit, units, done.stdout + done.stderr)
                self.assertFalse([line for line in docker if line.startswith("restart")])


def docker(stdout, returncode=0):
    return mock.patch.object(komodo_stack.subprocess, "run", return_value=subprocess.CompletedProcess([], returncode, stdout, ""))


class RunsHere(unittest.TestCase):
    def test_a_box_with_the_stack_s_containers_runs_it_under_komodo(self):
        with docker("c285685a37f0\n") as run:
            self.assertTrue(komodo_stack.runs_here())
        self.assertIn("label=com.docker.compose.project=box-sieun-pi", run.call_args.args[0])

    def test_a_box_without_the_stack_or_without_docker_keeps_its_units(self):
        with docker(""):
            self.assertFalse(komodo_stack.runs_here())
        with docker("", returncode=1):
            self.assertFalse(komodo_stack.runs_here())
        with mock.patch.object(komodo_stack.subprocess, "run", side_effect=FileNotFoundError("docker")):
            self.assertFalse(komodo_stack.runs_here())


if __name__ == "__main__":
    unittest.main()

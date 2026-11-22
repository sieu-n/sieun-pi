"""components/prime-sync/install.py writes no prime-sync.timer on a box whose Komodo Stack box-sieun-pi runs the sync (us-metal02 since 11-21)."""
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("prime_sync_install", Path(__file__).resolve().parents[1] / "components/prime-sync/install.py")
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


def docker(stdout, returncode=0):
    return mock.patch.object(install.subprocess, "run", return_value=subprocess.CompletedProcess([], returncode, stdout, ""))


class KomodoRunsIt(unittest.TestCase):
    def test_a_box_with_the_stack_s_containers_runs_it_under_komodo(self):
        with docker("c285685a37f0\n") as run:
            self.assertTrue(install.komodo_runs_it())
        self.assertIn("label=com.docker.compose.project=box-sieun-pi", run.call_args.args[0])

    def test_a_box_without_the_stack_or_without_docker_keeps_the_timer(self):
        with docker(""):
            self.assertFalse(install.komodo_runs_it())
        with docker("", returncode=1):
            self.assertFalse(install.komodo_runs_it())
        with mock.patch.object(install.subprocess, "run", side_effect=FileNotFoundError("docker")):
            self.assertFalse(install.komodo_runs_it())


if __name__ == "__main__":
    unittest.main()

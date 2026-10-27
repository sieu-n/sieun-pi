import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]


def load_board():
    spec = importlib.util.spec_from_file_location("board_own_under_test", REPO / "skills/board/src/board/__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BoardOwnTests(unittest.TestCase):
    """board.own() writes the record a job's end reads (legacy/prime/user-history/src/job-leftovers.ts readOwned), and refuses what it never deletes."""

    def test_own_records_paths_and_units_once_and_refuses_shared_folders(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            session = home / ".prime/agent/session-artifacts/01a14210-4e7d-72c3-aa67-e3d476f4e728/sub-1c2ca83f"
            session.mkdir(parents=True)
            env = {"HOME": str(home), "RLM_SESSION_DIR": str(session)}
            with patch.dict(os.environ, env), patch.object(Path, "home", return_value=home):
                os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
                os.environ.pop("PI_CODING_AGENT_DIR", None)
                board = load_board()
                board.own("~/scratch/my-job/tree", unit="my-job-rig.service")
                board.own(str(home / "scratch/my-job/tree") + "/", "/tmp/my-job-rig", unit="my-job-rig.service")
                record = json.loads((session / "owned.json").read_text())
                self.assertEqual(record, {"paths": [str(home / "scratch/my-job/tree"), "/tmp/my-job-rig"], "units": ["my-job-rig.service"]})
                for refused in ["~/scratch", "~/work", "~/src/sieun-pi/scripts/release-chat.mjs", str(session), str(session.parent)]:
                    with self.assertRaises(ValueError, msg=refused):
                        board.own(refused)
                with self.assertRaises(ValueError):
                    board.own("/tmp/x", unit="bad unit; rm -rf ~")

    def test_own_takes_work_trees_and_box_paths_a_session_made_over_ssh(self):
        """10-20: 22.4 GB of Mac jobs' trees on us-metal02 and 5 ~/work trees there had no record, since own() refused both kinds of path."""
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            session = home / ".prime/agent/session-artifacts/01a15427-145f-751d-ba15-d27b6c30f65f/sub-77630b38"
            session.mkdir(parents=True)
            hosts = home / "hosts.json"
            hosts.write_text(json.dumps({"version": 1, "hosts": [
                {"name": "us-metal02", "hostname": "us-metal02", "address": "100.83.139.73", "ssh": "sieun@100.83.139.73"},
                {"name": "here", "hostname": "this-box", "address": "100.66.173.18", "ssh": "me@100.66.173.18"}]}))
            env = {"HOME": str(home), "RLM_SESSION_DIR": str(session), "SIEUN_PI_HOSTS": str(hosts)}
            with patch.dict(os.environ, env), patch.object(Path, "home", return_value=home), patch("socket.gethostname", return_value="this-box.local"):
                os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
                os.environ.pop("PI_CODING_AGENT_DIR", None)
                board = load_board()
                board.own("~/work/my-job/build")
                board.own("/home/sieun/scratch/flow-at-scale-convex-scale", "~/work/prod-readback/", host="us-metal02")
                board.own("~/scratch/cs-scout-land-1hgn30jl", host="sieun@100.83.139.73")
                record = json.loads((session / "owned.json").read_text())
                self.assertEqual(record, {"paths": [str(home / "work/my-job/build")], "units": [], "hosts": {"us-metal02": [
                    "~/scratch/flow-at-scale-convex-scale", "~/work/prod-readback", "~/scratch/cs-scout-land-1hgn30jl"]}})
                for refused in ["~/src/sieun-pi", "~/scratch/../src", "/etc/x", "~/work"]:
                    with self.assertRaises(ValueError, msg=refused):
                        board.own(refused, host="us-metal02")
                with self.assertRaises(ValueError):
                    board.own("~/scratch/x", host="nowhere")
                with self.assertRaises(ValueError):
                    board.own(str(session.parent))
                board.own("~/scratch/local-tree", host="here")
                self.assertIn(str(home / "scratch/local-tree"), json.loads((session / "owned.json").read_text())["paths"])


if __name__ == "__main__":
    unittest.main()

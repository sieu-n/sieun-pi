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
    """board.own() writes the record a job's end reads (components/user-history/src/job-leftovers.ts readOwned), and refuses what it never deletes."""

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
                for refused in ["~/scratch", "~/work/my-job", "~/src/sieun-pi/scripts/release-chat.mjs", str(session), str(session.parent)]:
                    with self.assertRaises(ValueError, msg=refused):
                        board.own(refused)
                with self.assertRaises(ValueError):
                    board.own("/tmp/x", unit="bad unit; rm -rf ~")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]


def load_board():
    spec = importlib.util.spec_from_file_location("board_wake_under_test", REPO / "skills/board/src/board/__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BoardWakeTests(unittest.TestCase):
    """board.wake(run=, attempt=) writes the wake file the chat service ticks (components/user-history/src/wakes.ts parseWake)."""

    def test_run_wake_keeps_a_later_attempt_and_drops_attempt_one(self):
        """10-21: wakes set on promote run 39493311906 after attempt 1's cancel went out at once, before the rerun reached them."""
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            session = home / ".prime/agent/session-artifacts/01a14210-4e7d-72c3-aa67-e3d476f4e728"
            session.mkdir(parents=True)
            data = home / "chat"
            (data / "wakes").mkdir(parents=True)
            (data / "wakes" / ".ticked").write_text("")
            env = {"HOME": str(home), "RLM_SESSION_DIR": str(session), "AGENT_CHAT_DATA_DIR": str(data), "SIEUN_PI_HOSTS": str(home / "none.json")}
            with patch.dict(os.environ, env), patch.object(Path, "home", return_value=home):
                board = load_board()
                text = board.wake(run=39493311906, attempt=2, note="promote 17 readback")
                self.assertIn("run 39493311906 attempt 2 or later finishes", text)
                path = data / "wakes" / "01a14210-4e7d-72c3-aa67-e3d476f4e728-run-39493311906.json"
                self.assertEqual(json.loads(path.read_text())["on"], {"kind": "run", "run": 39493311906, "attempt": 2})
                board.wake(run=39493311906, attempt=1)
                self.assertEqual(json.loads(path.read_text())["on"], {"kind": "run", "run": 39493311906})
                with self.assertRaises(ValueError):
                    board.wake(run=39493311906, attempt=0)


if __name__ == "__main__":
    unittest.main()

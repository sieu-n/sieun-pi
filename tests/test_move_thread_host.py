"""The thread mover refuses without the owner's explicit ask for that thread (c131). Run: python3 -B -m unittest tests/test_move_thread_host.py"""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/move-thread-host.py"
THREAD = "01a11ba8-9d2c-727c-8ded-38f819ca9f29"
OTHER = "01a11b0b-7c15-73da-9481-8de15903eab4"


def b36(n):
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
    return s


class MoveThreadHostRefuses(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.hosts = {name: {"ssh": None, "agent": str(root / name), "socket": str(root / f"{name}.sock"), "prime": "false", "rsync": "rsync"}
                      for name in ("box", "mac")}
        for name in self.hosts:
            (root / name / "sessions").mkdir(parents=True)
        (root / "hosts.json").write_text(json.dumps(self.hosts))
        for sid, name in ((THREAD, "frontend bro"), (OTHER, "slack green guy")):
            (root / "box/sessions" / f"{sid}.jsonl").write_text(json.dumps({"type": "session", "id": sid}) + "\n" +
                                                                 json.dumps({"type": "session_info", "name": name}) + "\n")
        self.chat = root / "chat.jsonl"
        self.log = root / "moves.jsonl"
        self.at = 1792414171105

    def tearDown(self):
        self.dir.cleanup()

    def ask(self, text):
        self.at += 1000
        with open(self.chat, "a") as f:
            f.write(json.dumps({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}], "timestamp": self.at}}) + "\n")
        return b36(self.at)

    def mover(self, *args):
        env = {**os.environ, "MOVE_THREAD_HOSTS": str(Path(self.dir.name, "hosts.json")), "MOVE_THREAD_LOG": str(self.log)}
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True, env=env)

    def refused(self, ask, reason):
        r = self.mover("--thread", THREAD, "--chat", str(self.chat), "--owner-ask", ask)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        last = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(last["outcome"], "refused")
        self.assertIn(reason, last["reason"])
        self.assertTrue(Path(self.hosts["box"]["agent"], "sessions", f"{THREAD}.jsonl").exists())
        return last

    def test_no_owner_ask(self):
        r = self.mover("--thread", THREAD, "--chat", str(self.chat))
        self.assertEqual(r.returncode, 2)
        self.assertIn("--owner-ask", r.stderr)
        self.ask("hi")
        self.refused("zzzzzz", "no owner message zzzzzz")

    def test_ask_names_another_thread(self):
        self.refused(self.ask("undo the migration of slack green guy"), "does not name this thread")

    def test_broad_all_names_no_thread(self):
        self.refused(self.ask("yes move all off. ALL."), "does not name this thread")

    def test_ask_with_no_move(self):
        self.refused(self.ask("frontend bro 제대로 세팅 해 빨리"), "does not ask to move it")

    def test_quoted_chat_line_is_not_his_words(self):
        self.refused(self.ask("> frontend bro moves back the moment its sub-jobs finish\n\nok"), "does not name this thread")

    def test_board_choice_is_not_his_words(self):
        self.refused(self.ask('[board] Owner chose "Move frontend bro to the box" for "Where does frontend bro run?"'), "no words he typed")

    def test_named_move_ask_passes_the_check(self):
        last = self.refused(self.ask("move frontend bro back to the mac"), "cannot list agents on box")
        self.assertEqual(last["named"], "frontend bro")
        self.assertEqual(last["ownerWords"], "move frontend bro back to the mac")

    def test_board_answer_counts_as_his_words(self):
        last = self.refused(self.ask('[board] Owner checked "Where should it run?" and answered: move frontend bro to the box'), "cannot list agents")
        self.assertEqual(last["named"], "frontend bro")


if __name__ == "__main__":
    unittest.main()

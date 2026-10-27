"""`pi-pool snapshot --json`: one process answers the chat service's reads, and every
part is what the separate command prints (queue --json, config, and per thread who --json
and ls --json for each provider)."""
import contextlib, hashlib, io, json, os, subprocess, time, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import KEY, NOW, SOURCE, state_v2, vend
from vend.pool import base


def setUpModule():
    isolate_test_module()


def files(folder):
    """Every file under `folder` with a hash of its bytes."""
    out = {}
    for root, _, names in os.walk(folder):
        for name in names:
            path = os.path.join(root, name)
            with open(path, "rb") as f:
                out[os.path.relpath(path, folder)] = hashlib.sha256(f.read()).hexdigest()
    return out


class Snapshot(unittest.TestCase):
    def setUp(self):
        os.makedirs(base.ACCOUNTS, exist_ok=True)
        windows = [{"kind": "session", "label": "5h", "pct": 40, "resets_at": NOW + 3600},
                   {"name": "claude-fable-5-1", "usedPercentage": 100, "resetsAt": (NOW + 3600) * 1000}]
        for provider, ids in (("anthropic", ("a", "b")), ("openai-codex", ("c",))):
            with open(base.INDEX[provider], "w") as f:
                json.dump({"version": base.INDEX_VERSION, "accounts": [
                    {"id": i, "email": f"{i}@x", "label": f"{i}@x", "windows": windows, "lastUsageAt": (NOW - 60) * 1000} for i in ids]}, f)
        state = state_v2(current="b")
        state["turns"] = {"working": {KEY.key: {"tree": KEY.key, "class": "normal", "kind": "own", "since": NOW - 30, "pid": os.getpid(),
                                                "lease_until": NOW + 600}},
                          "queued": {"q1": {"tree": "T", "class": "low", "since": NOW - 90, "pid": os.getpid()}}, "owner": {}, "recent": {}}
        with open(base.STATE, "w") as f:
            json.dump(state, f)
        self.addCleanup(lambda: [os.remove(p) for p in (base.STATE, *base.INDEX.values()) if os.path.exists(p)])

    maxDiff = None

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = vend.cli(list(argv)) or 0
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else 1
        return {"code": code, "out": out.getvalue(), "err": err.getvalue()}

    def test_every_part_is_what_the_separate_command_prints(self):
        threads = [("", ""), (KEY.key, ""), (KEY.key, "claude-opus-4-5"), ("no-such-session", "")]
        with unittest.mock.patch("time.time", return_value=NOW), \
                unittest.mock.patch.object(vend.pool.registry, "session_key", lambda: None):
            said = self.cli("snapshot", "--json", *[a for t in threads for a in ("--thread", *t)])
            self.assertEqual(said["code"], 0, said)
            snapshot = json.loads(said["out"])
            self.assertEqual(snapshot["queue"], self.cli("queue", "--json"))
            self.assertEqual(snapshot["config"], self.cli("config"))
            self.assertEqual([(t["session"], t["model"]) for t in snapshot["threads"]],
                             [(s or None, m or None) for s, m in threads])
            for thread, (session, model) in zip(snapshot["threads"], threads):
                flags = [*(["--session", session] if session else []), *(["--model", model] if model else [])]
                self.assertEqual(thread["who"], self.cli("who", "--json", *flags))
                for provider in base.PROVIDERS:
                    self.assertEqual(thread["ls"][provider], self.cli("ls", "--json", "--provider", provider, *flags))
        queue = json.loads(snapshot["queue"]["out"])
        self.assertEqual(([w["session"] for w in queue["working"]], queue["queued"]), ([KEY.key, "q1"], []),
                         "a queued run with a slot free reads as the next locked call leaves it")
        listed = json.loads(snapshot["threads"][1]["ls"]["anthropic"]["out"])
        self.assertEqual(([r["id"] for r in listed["rows"]], listed["session"]), (["a", "b"], KEY.key))
        self.assertEqual(snapshot["threads"][3]["who"]["code"], 2)
        usable = [[r["usable"] for r in json.loads(t["ls"]["anthropic"]["out"])["rows"]] for t in snapshot["threads"][1:3]]
        self.assertNotEqual(usable[0], usable[1], "--model changes the rows, so the part carries it")

    def test_the_cli_answers_one_json_line_and_writes_nothing(self):
        before = files(base.POOL)
        # The pool this module wrote, named outright: under discover, test_tmp_sweep.py moves os.environ's PI_POOL_DIR when it loads.
        env = {k: v for k, v in os.environ.items() if k not in ("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
                                                                "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL")}
        env.update(PI_POOL_DIR=base.POOL, HOME=base.POOL)
        run = subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), "snapshot", "--json", "--thread", KEY.key, ""],
                             env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(len(run.stdout.splitlines()), 1)
        snapshot = json.loads(run.stdout)
        self.assertEqual(set(snapshot), {"queue", "config", "threads", "trees"})
        self.assertEqual(json.loads(snapshot["threads"][0]["ls"]["anthropic"]["out"])["session"], KEY.key)
        self.assertEqual(files(base.POOL), before)

    def test_a_tree_gives_the_class_its_record_holds_as_priority_writes_it(self):
        new = "01a14f1d-48e1-71ff-b38c-59f16a572748"
        trees = lambda: json.loads(self.cli("snapshot", "--json", "--tree", KEY.key, "--tree", new, "--tree", "no-such-session")["out"])["trees"]
        who = lambda session: json.loads(self.cli("who", "--json", "--session", session)["out"])["priority"]
        with unittest.mock.patch("time.time", return_value=NOW), unittest.mock.patch.object(vend.pool.registry, "session_key", lambda: None):
            self.assertEqual(trees(), [{"session": KEY.key, "priority": who(KEY.key), "label": None},
                                       {"session": new, "priority": None, "label": None}, {"session": "no-such-session", "priority": None, "label": None}])
            for argv, holds in ((("low",), ("low", None)), (("high", "--label"), ("high", "high")), (("normal",), ("normal", None))):
                self.assertEqual(self.cli("priority", *argv, "--session", KEY.key)["code"], 0)
                self.assertEqual((trees()[0]["priority"], trees()[0]["label"]), holds)
                self.assertEqual(trees()[0]["priority"], who(KEY.key))
            self.assertEqual(self.cli("priority", "low", "--session", new)["code"], 0)
            self.assertEqual(trees()[1], {"session": new, "priority": "low", "label": None})

    def test_a_thread_needs_a_session_and_a_model(self):
        self.assertNotEqual(self.cli("snapshot", "--json", "--thread", "s")["code"], 0)
        self.assertNotEqual(self.cli("snapshot", "--queue")["code"], 0)
        self.assertNotEqual(self.cli("snapshot", "--json", "--tree")["code"], 0)


if __name__ == "__main__":
    unittest.main()

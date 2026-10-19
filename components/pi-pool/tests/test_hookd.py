"""pool/hookd.py and the C hook client: a token request through the resident pool server vends what the
Python hook vends, falls back to the Python hook when hookd should not run it, logs a kill as the Python
hook does, and never vends twice."""
import base64, fcntl, importlib.util, json, os, shutil, signal, socket, subprocess, sys, tempfile, time, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODEX = "cccc3333-0000-0000-0000-000000000000"
FALLBACK = "#!/bin/sh\nprintf fallback-ran\necho ran >> \"$PI_POOL_DIR/fallback-runs\"\n"


def load_installer():
    spec = importlib.util.spec_from_file_location("pi_pool_installer", os.path.join(SOURCE, "install.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def jwt(claims):
    part = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return part({"alg": "none"}) + "." + part(claims) + ".fixture"


def make_pool(path):
    os.makedirs(os.path.join(path, "accounts", "openai-codex"))
    with open(os.path.join(path, "accounts", "openai-codex.json"), "w") as f:
        json.dump({"version": 1, "accounts": [{"id": CODEX, "email": "c@x", "label": "c@x", "tier": "plus", "windows": []}]}, f)
    token = jwt({"exp": int(time.time()) + 30 * 86400, "https://api.openai.com/auth": {"chatgpt_account_id": CODEX}})
    with open(os.path.join(path, "accounts", "openai-codex", CODEX + ".json"), "w") as f:
        json.dump({"tokens": {"access_token": token, "refresh_token": "fixture-refresh"}}, f)
    return token


def events(pool):
    try:
        with open(os.path.join(pool, "pi-pool.log")) as f:
            return [json.loads(line) for line in f]
    except FileNotFoundError:
        return []


def vends(pool):
    """state.json's sessions with every clock reading taken out."""
    with open(os.path.join(pool, "state.json")) as f:
        sessions = json.load(f)["sessions"]

    return timeless(sessions)


def timeless(value):
    """`value` with every float, a clock reading in the pool's records, and the queue's whole-second waits taken out."""
    if isinstance(value, dict):
        return {k: timeless(v) for k, v in value.items() if not isinstance(v, float) and k != "wait_s"}
    if isinstance(value, list):
        return [timeless(v) for v in value if not isinstance(v, float)]
    return value


def printed(text):
    """Printed output, whole or line by line, with the clock readings out of the JSON."""
    try:
        return timeless(json.loads(text))
    except ValueError:
        pass
    lines = []
    for line in text.splitlines():
        try:
            lines.append(timeless(json.loads(line)))
        except ValueError:
            lines.append(line)
    return lines


def ask(path, fields, fds=None):
    """One raw request to hookd and its answer line."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(path)
        body = b"PPH1\0" + b"".join(os.fsencode(str(f)) + b"\0" for f in fields)
        if fds:
            socket.send_fds(s, [body], fds)
        else:
            s.sendall(body)
        answer = b""
        while not answer.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            answer += chunk
        return answer.decode()


def request(mode, script, argv, env, cwd="/", ppid=None):
    return [mode, ppid or os.getpid(), cwd, script, len(argv), *argv, len(env), *(f"{k}={v}" for k, v in env.items())]


class Hookd(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pi-pool-hookd-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.release = os.path.join(self.root, "releases", "a")
        shutil.copytree(SOURCE, self.release, ignore=shutil.ignore_patterns("__pycache__", "tests"))
        built = load_installer().build_client(Path(self.release))
        self.assertTrue(built.startswith("built with"), built)
        self.link = os.path.join(self.root, "current")
        os.symlink(self.release, self.link)
        self.pool = os.path.join(self.root, "pool")
        self.token = make_pool(self.pool)
        self.env = dict(os.environ, HOME=self.root, PI_POOL_DIR=self.pool, PI_POOL_SECRETS="file",
                        PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-hookd")
        self.env.pop("PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL", None)
        self.env.pop("PI_POOL_SESSION_KEY", None)
        self.server = subprocess.Popen(["/usr/bin/python3", "-B", os.path.join(self.link, "bin", "pi-pool"), "hookd",
                                        "--release", self.link], env=self.env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(self.stop_server)
        self.socket = os.path.join(self.pool, "hook.sock")
        deadline = time.monotonic() + 20
        while not os.path.exists(self.socket):
            if self.server.poll() is not None or time.monotonic() > deadline:
                self.fail("hookd did not start: " + self.server.stderr.read().decode())
            time.sleep(0.02)
        self.assertEqual(os.stat(self.socket).st_mode & 0o777, 0o600)
        # hookd loaded the Python hook already; the file now shows when a client ran the Python path instead.
        self.python_hook = os.path.join(self.release, "bin", "pi-pool-token.py")
        self.real_hook = os.path.join(self.release, "bin", "python-hook.py")
        shutil.copy(self.python_hook, self.real_hook)
        with open(self.python_hook, "w") as f:
            f.write(FALLBACK)

    def stop_server(self):
        if self.server.poll() is None:
            self.server.terminate()
            self.server.wait(10)
        self.server.stderr.close()

    def client(self, *args, env=None, **kw):
        return subprocess.run([os.path.join(self.link, "bin", "pi-pool-token"), *args], env=env or self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, **kw)

    def fallback_runs(self, pool=None):
        try:
            with open(os.path.join(pool or self.pool, "fallback-runs")) as f:
                return len(f.readlines())
        except FileNotFoundError:
            return 0

    def test_the_client_gets_the_token_and_vend_record_the_python_hook_gives(self):
        served = self.client("--provider", "openai-codex")
        self.assertEqual((served.returncode, served.stdout, self.fallback_runs()), (0, self.token, 0), served.stderr)
        twin = os.path.join(self.root, "twin")
        make_pool(twin)
        shutil.copy(os.path.join(self.pool, "accounts", "openai-codex", CODEX + ".json"),
                    os.path.join(twin, "accounts", "openai-codex", CODEX + ".json"))
        python = subprocess.run(["/usr/bin/python3", "-B", self.real_hook, "--provider", "openai-codex"],
                                env=dict(self.env, PI_POOL_DIR=twin), stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=60, cwd=self.release)
        self.assertEqual((python.returncode, python.stdout), (0, self.token), python.stderr)
        self.assertEqual(vends(self.pool), vends(twin))
        with open(os.path.join(self.pool, "state.json")) as f:
            self.assertEqual(json.load(f)["sessions"]["fixture-hookd"]["pid"], os.getpid(), "the vend names the client's parent")
        self.assertEqual([e["event"] for e in events(self.pool) if e["event"] != "hookd_start"],
                         [e["event"] for e in events(twin)])

    def queue_of_one(self, *pools):
        for pool in pools:
            with open(os.path.join(pool, "config.json"), "w") as f:
                json.dump({"agent_queue_on": 1, "working_max": 1, "tree_working_max": 1}, f)

    def agent_dir(self, pool):
        folder = os.path.join(pool, "agent")
        os.makedirs(folder)
        with open(os.path.join(folder, "models.json"), "w") as f:
            json.dump({"providers": {"openai-codex": {"apiKey": "!/x/pi-pool/bin/pi-pool-token --provider openai-codex"}}}, f)
        with open(os.path.join(folder, "auth.json"), "w") as f:
            json.dump({"openai-codex": {"type": "oauth", "access": "fixture-own-login"}}, f)
        return folder

    def test_cli_commands_print_what_the_python_path_prints(self):
        twin = os.path.join(self.root, "twin")
        make_pool(twin)
        self.queue_of_one(self.pool, twin)
        with open(os.path.join(self.pool, "accounts", "anthropic.json"), "w") as f, \
                open(os.path.join(twin, "accounts", "anthropic.json"), "w") as g:
            json.dump({"version": 1, "accounts": []}, f)
            json.dump({"version": 1, "accounts": []}, g)
        here = dict(self.env, PRIME_AGENT_CODING_AGENT_DIR=self.agent_dir(self.pool))
        there = dict(self.env, PI_POOL_DIR=twin, PRIME_AGENT_CODING_AGENT_DIR=self.agent_dir(twin))
        commands = [["admit", "fixture-turn-1"], ["admit", "fixture-turn-2"], ["queue", "--json"], ["who", "--json"],
                    ["model", "fixture-model", "--provider", "openai-codex", "--source", "fixture-hookd"],
                    ["ls", "--json", "--provider", "openai-codex"], ["adopt-logins"], ["probe", "--force"],
                    ["release", "fixture-turn-1"], ["release", "fixture-turn-2"], ["config"], ["no-such-command"]]
        for command in commands:
            with self.subTest(command=command):
                served = self.client("--cli", *command, env=here)
                python = subprocess.run(["/usr/bin/python3", "-B", self.real_hook, "--cli", *command], env=there,
                                        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
                self.assertEqual((served.returncode, printed(served.stdout), served.stderr),
                                 (python.returncode, printed(python.stdout), python.stderr))
        self.assertEqual(self.fallback_runs(), 0)
        self.assertEqual(vends(self.pool)["fixture-hookd"].get("models"), vends(twin)["fixture-hookd"].get("models"))
        for pool in (self.pool, twin):
            with open(os.path.join(pool, "fallback.json")) as f:
                self.assertEqual(json.load(f)["openai-codex"]["access"], "fixture-own-login")

    def turns(self):
        with open(os.path.join(self.pool, "turns.json")) as f:
            return json.load(f)

    def waiting_admit(self, session, shell):
        """A blocked `admit --wait`, started under sh when `shell` is set, and the pid the queue should name."""
        args = [os.path.join(self.link, "bin", "pi-pool-token"), "--cli", "admit", session, "--wait"]
        argv = ["/bin/sh", "-c", " ".join(args) + "; exit $?"] if shell else args
        waiting = subprocess.Popen(argv, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: waiting.poll() is None and (waiting.kill(), waiting.communicate()))
        self.assertEqual(json.loads(waiting.stdout.readline())["state"], "queued")
        return waiting, waiting.pid if shell else os.getpid()

    def test_admit_wait_blocks_in_hookd_for_the_clients_parent(self):
        self.queue_of_one(self.pool)
        first = self.client("--cli", "admit", "fixture-turn-1")
        self.assertEqual(json.loads(first.stdout)["state"], "admitted", first.stderr)
        waiting, parent = self.waiting_admit("fixture-turn-2", shell=True)
        self.assertEqual(self.turns()["queued"]["fixture-turn-2"]["pid"], parent)
        time.sleep(1.5)
        self.assertIsNone(waiting.poll(), "admit --wait still waits")
        self.client("--cli", "release", "fixture-turn-1")
        out, err = waiting.communicate(timeout=30)
        self.assertEqual((waiting.returncode, json.loads(out.splitlines()[-1])["state"]), (0, "admitted"), err)
        self.assertEqual(self.fallback_runs(), 0)

    def test_a_sigterm_ends_a_waiting_cli_run(self):
        self.queue_of_one(self.pool)
        self.client("--cli", "admit", "fixture-turn-1")
        waiting, _ = self.waiting_admit("fixture-turn-2", shell=False)
        waiter = self.turns()["queued"]["fixture-turn-2"]["waiter"]
        os.kill(waiter, 0)
        waiting.send_signal(signal.SIGTERM)
        waiting.communicate(timeout=10)
        self.assertEqual(waiting.returncode, -signal.SIGTERM)
        deadline = time.monotonic() + 10
        while True:
            try:
                os.kill(waiter, 0)
            except ProcessLookupError:
                break
            self.assertLess(time.monotonic(), deadline, "the run in hookd outlived its client")
            time.sleep(0.05)

    def test_a_cli_run_reads_the_clients_stdin(self):
        harvest = json.dumps({"provider": "fixture-provider"})
        for script in (os.path.join(self.link, "bin", "pi-pool-token"), self.real_hook):
            with self.subTest(script=script):
                run = subprocess.run([script, "--cli", "file-login"], env=self.env, input=harvest, capture_output=True,
                                     text=True, timeout=60)
                self.assertEqual((run.returncode, run.stdout, run.stderr), (1, "", "unknown provider fixture-provider\n"))
        self.assertEqual(self.fallback_runs(), 0)

    def test_a_tty_or_other_arguments_run_the_python_hook(self):
        for args in (["--status"], ["--cli", "token", "c@x"], ["--cli", "watch"], ["--help"]):
            with self.subTest(args=args):
                run = self.client(*args)
                self.assertEqual(run.stdout, "fallback-ran")

    def test_a_pool_dir_named_another_way_falls_back(self):
        alias = os.path.join(self.root, "alias")
        os.symlink(self.pool, alias)
        run = self.client("--provider", "openai-codex", env=dict(self.env, PI_POOL_DIR=alias))
        self.assertEqual((run.returncode, run.stdout, self.fallback_runs()), (0, "fallback-ran", 1))
        answer = ask(self.socket, request("pipe", os.path.join(self.link, "bin", "pi-pool"), ["config"], dict(self.env, HOME="/")))
        self.assertEqual(answer, "F\n")

    def test_the_global_rules_folder_on_pythonpath_runs_through_hookd(self):
        guard = os.path.join(self.root, "src", "components", "global-rules", "python-child")
        os.makedirs(guard)
        given = self.env.get("PYTHONPATH")
        paths = {"guarded": [guard], "other": [os.path.join(self.root, "src", "elsewhere")]}
        for name, extra in paths.items():
            with self.subTest(pythonpath=name):
                env = dict(self.env, PYTHONPATH=":".join(extra + ([given] if given else [])))
                run = self.client("--provider", "openai-codex", env=env)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout, self.token if name == "guarded" else "fallback-ran")
        self.assertEqual(self.fallback_runs(), 1)
        run = self.client("--provider", "openai-codex", env=dict(self.env, PYTHONSAFEPATH="1"))
        self.assertEqual((run.stdout, self.fallback_runs()), ("fallback-ran", 2))

    def test_a_script_outside_the_loaded_release_falls_back(self):
        other = os.path.join(self.root, "other", "bin")
        os.makedirs(other)
        self.assertEqual(ask(self.socket, request("pipe", os.path.join(other, "pi-pool"), ["config"], self.env)), "F\n")

    def test_a_moved_release_falls_back_and_hookd_exits(self):
        moved = os.path.join(self.root, "releases", "b")
        shutil.copytree(self.release, moved)
        os.symlink(moved, self.link + ".new")
        os.replace(self.link + ".new", self.link)
        run = self.client("--provider", "openai-codex")
        self.assertEqual((run.returncode, run.stdout), (0, "fallback-ran"))
        self.assertEqual(self.server.wait(10), 0)
        self.assertEqual(events(self.pool)[-1]["event"], "hookd_moved")

    def test_pipe_mode_answers_what_the_cli_prints(self):
        cli = os.path.join(self.link, "bin", "pi-pool")
        answer = ask(self.socket, request("pipe", cli, ["config"], self.env))
        self.assertTrue(answer.startswith("J "), answer)
        got = json.loads(answer[2:])
        direct = subprocess.run(["/usr/bin/python3", "-B", cli, "config"], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(got, {"code": direct.returncode, "out": direct.stdout, "err": direct.stderr})
        failed = json.loads(ask(self.socket, request("pipe", cli, ["no-such-command"], self.env))[2:])
        self.assertEqual(failed["code"], 1)
        self.assertIn("usage: pi-pool", failed["err"])

    def test_serve_hands_its_runs_to_hookd(self):
        code = ("import importlib.util, json, os, sys\n"
                "spec = importlib.util.spec_from_file_location('vend', sys.argv[1]); vend = importlib.util.module_from_spec(spec)\n"
                "sys.modules['vend'] = vend; spec.loader.exec_module(vend); remote = vend.pool.remote\n"
                "env = remote.holder_env(None)\n"
                "print(json.dumps([remote.via_hookd(*remote.holder_script(sys.argv[2], argv), env)\n"
                "                  for argv in (['--provider', 'openai-codex'], ['--cli', 'config'])]))\n")
        run = subprocess.run(["/usr/bin/python3", "-B", "-c", code, os.path.join(self.link, "vend.py"), self.link], env=self.env,
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        token, config = json.loads(run.stdout)
        self.assertEqual((token, self.fallback_runs()), ([0, self.token, ""], 0))
        self.assertEqual(config[0], 0)
        self.assertIn("pin_ttl_sec", json.loads(config[1]))

    def test_fd_mode_writes_to_the_clients_fds_and_sees_its_cwd_and_parent(self):
        cli = os.path.join(self.link, "bin", "pi-pool")
        out_r, out_w = os.pipe()
        with open(os.devnull) as null:
            answer = ask(self.socket, request("fd", cli, ["config"], self.env, cwd=self.root, ppid=4242),
                         [null.fileno(), out_w, out_w])
        os.close(out_w)
        with os.fdopen(out_r) as f:
            printed = f.read()
        self.assertEqual(answer, "X 0\n")
        self.assertEqual(json.loads(printed), json.loads(subprocess.run(
            ["/usr/bin/python3", "-B", cli, "config"], env=self.env, capture_output=True, text=True, timeout=60).stdout))

    def held_lock(self):
        held = open(os.path.join(self.pool, "lock"), "w")
        fcntl.flock(held.fileno(), fcntl.LOCK_EX)
        self.addCleanup(held.close)
        return held

    def test_a_sigterm_mid_vend_is_logged_as_interrupted(self):
        self.held_lock()
        hook = subprocess.Popen([os.path.join(self.link, "bin", "pi-pool-token"), "--provider", "openai-codex"], env=self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        hook.send_signal(signal.SIGTERM)
        out, _ = hook.communicate(timeout=10)
        self.assertEqual((hook.returncode, out, self.fallback_runs()), (128 + signal.SIGTERM, "", 0))
        rows = events(self.pool)
        [no_token] = [e for e in rows if e["event"] == "hook_no_token"]
        self.assertEqual((no_token["reason"], no_token["signal"], no_token["phase"]), ("interrupted", signal.SIGTERM, "vend"))
        [killed] = [e for e in rows if e["event"] == "hook_killed"]
        self.assertEqual((killed["provider"], killed["session"]), ("openai-codex", "fixture-hookd"))

    @unittest.skipUnless(sys.platform == "linux", "PR_SET_PDEATHSIG is Linux only, and the Mac's /bin/sh execs a lone hook command, so the timeout SIGTERM reaches the hook itself")
    def test_the_shells_timeout_reaches_the_run(self):
        self.held_lock()
        hook = subprocess.Popen(["/bin/sh", "-c", f"{os.path.join(self.link, 'bin', 'pi-pool-token')} --provider openai-codex; true"],
                                env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.5)
        hook.send_signal(signal.SIGKILL)
        hook.communicate(timeout=10)
        deadline = time.monotonic() + 10
        while not [e for e in events(self.pool) if e["event"] == "hook_no_token"] and time.monotonic() < deadline:
            time.sleep(0.05)
        [no_token] = [e for e in events(self.pool) if e["event"] == "hook_no_token"]
        self.assertEqual((no_token["reason"], no_token["signal"]), ("interrupted", signal.SIGTERM))

    def test_no_second_vend_when_hookd_dies_mid_run(self):
        self.held_lock()
        hook = subprocess.Popen([os.path.join(self.link, "bin", "pi-pool-token"), "--provider", "openai-codex"], env=self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while not (children := subprocess.run(["pgrep", "-P", str(self.server.pid)], capture_output=True, text=True).stdout.split()):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.server.kill()
        for pid in children:
            os.kill(int(pid), signal.SIGKILL)
        out, _ = hook.communicate(timeout=10)
        self.assertEqual((hook.returncode, out, self.fallback_runs()), (1, "", 0))

    def test_no_hookd_runs_the_python_hook(self):
        self.stop_server()
        run = self.client("--provider", "openai-codex")
        self.assertEqual((run.returncode, run.stdout, self.fallback_runs()), (0, "fallback-ran", 1))


if __name__ == "__main__":
    unittest.main()

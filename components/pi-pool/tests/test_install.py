"""install.py against a throwaway git checkout and HOME: what ships, the links,
the atomic flip, rollback, and the two refusals."""
import importlib.util, json, os, shutil, subprocess, tempfile, unittest
from unittest import mock
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


INSTALLER = Path(__file__).resolve().parents[1] / "install.py"
HOOK = """#!/bin/sh
[ -e "$PI_POOL_DIR/hook-waits" ] && [ "$PRIME_CREDENTIAL_COMMAND_PROTOCOL" = 1 ] && {
  echo "pi-pool-token: no token (slot_wait)" >&2; printf '{"retryAt": 1760000000, "message": "waiting for an account slot"}'; exit 75; }
[ -e "$PI_POOL_DIR/hook-waits" ] && { echo "pi-pool-token: no token (slot_wait)" >&2; exit 1; }
[ -e "$PI_POOL_DIR/hook-fails" ] && grep -q "$(cat "$PI_POOL_DIR/hook-fails")" "$(dirname "$0")/../vend.py" && exit 3
printf 'fixture-token-%s' 0123456789abcdefghij
"""


def load_installer():
    spec = importlib.util.spec_from_file_location("pool_installer", INSTALLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Install(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="pi-pool-install-"))
        self.addCleanup(self.cleanup)
        self.repo, self.home = self.base / "checkout", self.base / "home"
        self.home.mkdir()
        # One pooled account per provider, so install runs both hooks.
        self.accounts = self.home / ".config/pi-pool/accounts"
        self.accounts.mkdir(parents=True)
        for provider in ("anthropic", "openai-codex"):
            (self.accounts / f"{provider}.json").write_text(json.dumps({"version": 1, "accounts": [{"id": "fixture-account"}]}))
        component = self.repo / "components/pi-pool"
        for path, text in {"vend.py": "VERSION = 1\n", "bin/pi-pool": "#!/bin/sh\n", "bin/pi-pool-token": HOOK,
                           "app/extension/index.ts": "export default () => {};\n",
                           "tests/test_ok.py": "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n"}.items():
            (component / path).parent.mkdir(parents=True, exist_ok=True)
            (component / path).write_text(text)
        for name in ("bin/pi-pool", "bin/pi-pool-token"):
            os.chmod(component / name, 0o755)
        shutil.copy(INSTALLER, component / "install.py")
        self.git("init", "-q")
        self.commit("first")

    def cleanup(self):
        subprocess.run(["chmod", "-R", "u+w", str(self.base)])
        shutil.rmtree(self.base)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@example.test", *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message, **files):
        for path, text in files.items():
            (self.repo / "components/pi-pool" / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD:components/pi-pool")[:12]

    def run_installer(self, *args, env=None):
        done = subprocess.run(["/usr/bin/python3", "-B", str(self.repo / "components/pi-pool/install.py"), *args,
                               "--home", str(self.home)], capture_output=True, text=True, env=env)
        return done.returncode, json.loads(done.stdout) if done.returncode == 0 else done.stderr

    def current(self):
        return os.readlink(self.home / ".local/share/pi-pool/current")

    def test_install_links_every_runtime_path_through_current_and_is_idempotent(self):
        first = self.git("rev-parse", "HEAD:components/pi-pool")[:12]
        code, out = self.run_installer()
        self.assertEqual(code, 0, out)
        self.assertEqual((out["current"], out["previous"], self.current()), (first, None, f"releases/{first}"))
        self.assertEqual({p: h["ok"] for p, h in out["hooks"].items()}, {"anthropic": True, "openai-codex": True})
        current = self.home / ".local/share/pi-pool/current"
        for name, inside in {".config/pi-pool/bin": "bin", ".config/pi-pool/app": "app", ".config/pi-pool/vend.py": "vend.py",
                             ".local/bin/pi-pool": "bin/pi-pool", ".prime/agent/extensions/pi-pool": "app/extension"}.items():
            self.assertEqual(os.readlink(self.home / name), str(current / inside))
        release = self.home / ".local/share/pi-pool/releases" / first
        self.assertFalse(os.access(release / "vend.py", os.W_OK), "an installed release is read-only")
        self.assertEqual(json.loads((release / "RELEASE.json").read_text())["commit"], self.git("rev-parse", "HEAD"))
        code, again = self.run_installer()
        self.assertEqual((code, again["tests"], again["relinked"], again["previous"]), (0, "already installed", [], first))

    def test_a_machine_with_no_pooled_account_yet_installs_and_skips_both_hooks(self):
        shutil.rmtree(self.accounts)
        (self.home / ".config/pi-pool/hook-fails").write_text("VERSION")
        code, out = self.run_installer()
        self.assertEqual(code, 0, out)
        self.assertEqual({p: (h["ok"], h["skipped"]) for p, h in out["hooks"].items()},
                         {"anthropic": (True, "no pooled account yet"), "openai-codex": (True, "no pooled account yet")})

    def borrow(self, holder, secret):
        done = subprocess.run(["/usr/bin/python3", "-B", str(self.repo / "components/pi-pool/install.py"), "--borrow", holder,
                               "--home", str(self.home)], input=secret, capture_output=True, text=True)
        return done.returncode, json.loads(done.stdout) if done.returncode == 0 else done.stderr

    def test_borrow_writes_remote_json_and_checks_both_hooks_through_the_holder(self):
        shutil.rmtree(self.accounts)
        code, out = self.borrow("http://100.83.139.73:7781/", "s3cret\n")
        self.assertEqual(code, 0, out)
        remote = self.home / ".config/pi-pool/remote.json"
        self.assertEqual(json.loads(remote.read_text()), {"url": "http://100.83.139.73:7781", "secret": "s3cret"})
        self.assertEqual(remote.stat().st_mode & 0o777, 0o600)
        self.assertEqual(({p: h["ok"] for p, h in out["hooks"].items()}, out["borrow"]["remote_changed"]),
                         ({"anthropic": True, "openai-codex": True}, True), "with remote.json no hook is skipped")
        self.assertEqual(set(out["borrow"]["enable"]), {"anthropic", "openai-codex"})
        code, again = self.borrow("http://100.83.139.73:7781", "s3cret")
        self.assertEqual((code, again["borrow"]["remote_changed"]), (0, False))

    def test_borrow_refuses_a_machine_that_holds_accounts_and_leaves_nothing_installed(self):
        code, err = self.borrow("http://100.83.139.73:7781", "s3cret")
        self.assertEqual(code, 1)
        self.assertIn("holds pooled accounts", err)
        self.assertFalse((self.home / ".config/pi-pool/remote.json").exists())
        self.assertFalse((self.home / ".local/share/pi-pool/current").is_symlink())

    def test_pool_modules_ship_with_bytecode_for_the_hook_interpreter(self):
        (self.repo / "components/pi-pool/pool").mkdir()
        self.commit("pool", **{"pool/__init__.py": "VALUE = 1\n"})
        code, out = self.run_installer()
        self.assertEqual(code, 0, out)
        source = os.path.realpath(self.home / ".local/share/pi-pool/current/pool/__init__.py")
        where = subprocess.run(["/usr/bin/python3", "-c", "import importlib.util, sys; print(importlib.util.cache_from_source(sys.argv[1]))", source],
                               capture_output=True, text=True, check=True).stdout.strip()
        self.assertTrue(os.path.isfile(where), where)

    def add_client(self):
        source = INSTALLER.parent
        for name in ("bin/pi-pool-token.c", "deploy/systemd/pi-pool-hookd.service"):
            (self.repo / "components/pi-pool" / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(source / name, self.repo / "components/pi-pool" / name)
        self.commit("client")

    def test_install_builds_the_hook_client_and_writes_the_hookd_unit(self):
        self.add_client()
        code, out = self.run_installer()
        self.assertEqual(code, 0, out)
        bin_dir = self.home / ".local/share/pi-pool/current/bin"
        self.assertNotEqual((bin_dir / "pi-pool-token").read_bytes(), HOOK.encode())
        self.assertTrue(os.access(bin_dir / "pi-pool-token", os.X_OK))
        self.assertEqual((bin_dir / "pi-pool-token.py").read_text(), HOOK)
        self.assertTrue(out["client"].startswith("built with"), out)
        unit = self.home / ".config/systemd/user/pi-pool-hookd.service"
        self.assertEqual(unit.read_text(), (INSTALLER.parent / "deploy/systemd/pi-pool-hookd.service").read_text())
        self.assertEqual(out["hookd"], {"unit": str(unit), "systemctl": "skipped: not this user's systemd"})
        self.assertIsNone(out["serve"])
        # No hookd answers in this HOME, so the client ran the Python hook for both providers.
        self.assertEqual({p: h["ok"] for p, h in out["hooks"].items()}, {"anthropic": True, "openai-codex": True})

    def test_with_no_cc_the_python_hook_stays_bin_pi_pool_token(self):
        self.add_client()
        path = self.base / "path"
        path.mkdir()
        os.symlink(shutil.which("git"), path / "git")
        code, out = self.run_installer(env=dict(os.environ, PATH=str(path)))
        self.assertEqual(code, 0, out)
        bin_dir = self.home / ".local/share/pi-pool/current/bin"
        self.assertEqual((bin_dir / "pi-pool-token").read_text(), HOOK)
        self.assertFalse((bin_dir / "pi-pool-token.py").exists())
        self.assertEqual(out["client"], "no cc; bin/pi-pool-token is the Python hook")

    def add_node_test(self):
        self.commit("native test", **{"tests/test_ok.py": """import subprocess, unittest
class T(unittest.TestCase):
    def test_node(self):
        self.assertEqual(subprocess.check_output(["node", "-p", "6 * 7"], text=True).strip(), "42")
"""})

    def test_non_login_path_discovers_current_users_node_for_staged_tests(self):
        self.add_node_test()
        caller_home = self.base / "caller"
        node = caller_home / ".local/bin/node"
        node.parent.mkdir(parents=True)
        node.symlink_to(shutil.which("node"))
        code, out = self.run_installer(env=dict(os.environ, HOME=str(caller_home), PATH="/usr/bin:/bin:/usr/sbin:/sbin"))
        self.assertEqual(code, 0, out)
        self.assertIn("OK", out["tests"])

    def test_resolved_node_path_reaches_the_client_compiler(self):
        self.add_client()
        caller_home = self.base / "caller"
        node = caller_home / ".local/bin/node"
        node.parent.mkdir(parents=True)
        node.symlink_to(shutil.which("node"))
        tools = self.base / "tools"
        tools.mkdir()
        marker = self.base / "compiler-node.txt"
        compiler = tools / "cc"
        compiler.write_text(f"#!/bin/sh\nnode -p '6 * 7' > '{marker}' || exit 1\nexec '{shutil.which('cc')}' \"$@\"\n")
        compiler.chmod(0o755)
        code, out = self.run_installer(env=dict(os.environ, HOME=str(caller_home), PATH=f"{tools}:/usr/bin:/bin:/usr/sbin:/sbin"))
        self.assertEqual(code, 0, out)
        self.assertEqual(marker.read_text().strip(), "42")
        self.assertEqual(out["client"], f"built with {compiler}")

    def test_only_committed_source_ships(self):
        (self.repo / "components/pi-pool/vend.py").write_text("HALF EDITED\n")
        code, out = self.run_installer()
        self.assertEqual(code, 0, out)
        self.assertEqual((self.home / ".config/pi-pool/vend.py").read_text(), "VERSION = 1\n")

    def test_a_new_commit_flips_current_and_rollback_flips_it_back(self):
        first = self.git("rev-parse", "HEAD:components/pi-pool")[:12]
        self.run_installer()
        second = self.commit("second", **{"vend.py": "VERSION = 2\n"})
        code, out = self.run_installer()
        self.assertEqual((code, out["current"], out["previous"]), (0, second, first))
        self.assertEqual((self.home / ".config/pi-pool/vend.py").read_text(), "VERSION = 2\n")
        code, back = self.run_installer("rollback")
        self.assertEqual((code, back["current"], back["previous"]), (0, first, second))
        self.assertEqual((self.home / ".config/pi-pool/vend.py").read_text(), "VERSION = 1\n")

    def test_rollback_after_the_first_install_puts_the_old_links_back(self):
        (self.home / ".config/pi-pool").mkdir(parents=True, exist_ok=True)
        checkout_bin = self.repo / "components/pi-pool/bin"
        (self.home / ".config/pi-pool/bin").symlink_to(checkout_bin)
        self.run_installer()
        code, back = self.run_installer("rollback")
        self.assertEqual((code, back["current"]), (0, None), back)
        self.assertEqual({p: h["ok"] for p, h in back["hooks"].items()}, {"anthropic": True, "openai-codex": True})
        self.assertEqual(os.readlink(self.home / ".config/pi-pool/bin"), str(checkout_bin))
        self.assertFalse((self.home / ".config/pi-pool/app").is_symlink())
        self.assertFalse((self.home / ".local/share/pi-pool/current").is_symlink())

    def test_failing_tests_change_nothing(self):
        first = self.git("rev-parse", "HEAD:components/pi-pool")[:12]
        self.run_installer()
        self.commit("broken", **{"tests/test_ok.py": "import unittest\nclass T(unittest.TestCase):\n    def test_no(self): self.fail('red')\n"})
        code, err = self.run_installer()
        self.assertEqual(code, 1)
        self.assertIn("pool tests failed", err)
        self.assertEqual(self.current(), f"releases/{first}")
        self.assertEqual(sorted(p.name for p in (self.home / ".local/share/pi-pool/releases").iterdir()), [first])

    def test_a_release_whose_hook_fails_puts_the_previous_one_back(self):
        first = self.git("rev-parse", "HEAD:components/pi-pool")[:12]
        self.run_installer()
        self.commit("hook breaks", **{"vend.py": "VERSION = 3\n"})
        (self.home / ".config/pi-pool/hook-fails").write_text("VERSION = 3")
        code, err = self.run_installer()
        self.assertEqual(code, 1)
        self.assertIn("hook check failed", err)
        self.assertEqual(self.current(), f"releases/{first}")

    def test_a_hook_that_answers_with_a_slot_wait_passes_the_check(self):
        (self.home / ".config/pi-pool/hook-waits").write_text("")
        for protocol, exit_code in ((None, 1), ("1", 75)):
            with self.subTest(protocol=protocol):
                env = {k: v for k, v in os.environ.items() if k != "PRIME_CREDENTIAL_COMMAND_PROTOCOL"}
                if protocol:
                    env["PRIME_CREDENTIAL_COMMAND_PROTOCOL"] = protocol
                code, out = self.run_installer(env=env)
                self.assertEqual(code, 0, out)
                self.assertEqual({p: (h["ok"], h.get("answer"), h["exit"], h["token_chars"]) for p, h in out["hooks"].items()},
                                 {"anthropic": (True, "slot_wait", exit_code, 0), "openai-codex": (True, "slot_wait", exit_code, 0)})

    def test_a_first_install_whose_hook_fails_puts_the_old_links_back(self):
        (self.home / ".config/pi-pool").mkdir(parents=True, exist_ok=True)
        (self.home / ".config/pi-pool/hook-fails").write_text("VERSION = 1")
        (self.home / ".config/pi-pool/bin").symlink_to("/checkout/bin")
        code, err = self.run_installer()
        self.assertEqual(code, 1)
        self.assertIn("back as they were", err)
        self.assertEqual(os.readlink(self.home / ".config/pi-pool/bin"), "/checkout/bin")
        self.assertFalse((self.home / ".config/pi-pool/app").is_symlink())
        self.assertFalse((self.home / ".local/share/pi-pool/current").is_symlink())

    def test_a_release_without_the_hook_puts_the_previous_one_back(self):
        first = self.git("rev-parse", "HEAD:components/pi-pool")[:12]
        self.run_installer()
        (self.repo / "components/pi-pool/bin/pi-pool-token").unlink()
        self.commit("hook deleted")
        code, err = self.run_installer()
        self.assertEqual(code, 1)
        self.assertIn('"exit": "FileNotFoundError"', err)
        self.assertEqual(self.current(), f"releases/{first}")

    def test_a_real_file_at_a_runtime_path_is_refused(self):
        (self.home / ".local/bin").mkdir(parents=True)
        (self.home / ".local/bin/pi-pool").write_text("someone else's\n")
        code, err = self.run_installer()
        self.assertEqual(code, 1)
        self.assertIn("is not a link", err)
        self.assertEqual((self.home / ".local/bin/pi-pool").read_text(), "someone else's\n")


class InstallerEnvironment(unittest.TestCase):
    def setUp(self):
        self.installer = load_installer()
        self.temporary = tempfile.TemporaryDirectory(prefix="pi-pool-node-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.node = shutil.which("node")
        self.assertIsNotNone(self.node, "installer tests require Node.js")

    def node_at(self, directory):
        directory.mkdir(parents=True)
        (directory / "node").symlink_to(self.node)
        return directory

    def test_caller_path_has_precedence_and_other_environment_is_unchanged(self):
        caller = self.node_at(self.home / "caller")
        self.node_at(self.home / ".local/bin")
        environment = {"PATH": str(caller), "FIXTURE": "preserved"}
        resolved = self.installer.installer_environment(environment, self.home)
        self.assertEqual(resolved, environment)
        self.assertIsNot(resolved, environment)

    def test_empty_and_non_login_path_append_only_the_discovered_node_directory(self):
        directory = self.node_at(self.home / ".local/bin")
        for path in ("", "/usr/bin:/bin:/usr/sbin:/sbin"):
            with self.subTest(path=path):
                environment = {"PATH": path, "FIXTURE": "preserved"}
                which = shutil.which
                with mock.patch.object(self.installer.shutil, "which", side_effect=lambda tool, path: None if path == environment["PATH"] else which(tool, path=path)):
                    resolved = self.installer.installer_environment(environment, self.home)
                self.assertEqual(resolved["PATH"], path + os.pathsep + str(directory) if path else str(directory))
                self.assertEqual(environment, {"PATH": path, "FIXTURE": "preserved"})
                self.assertEqual(resolved["FIXTURE"], "preserved")
                done = subprocess.run(["node", "-p", "6 * 7"], env=resolved, capture_output=True, text=True)
                self.assertEqual((done.returncode, done.stdout.strip()), (0, "42"), done.stderr)

    def test_user_node_installations_are_discovered_without_resolving_away_the_bin_directory(self):
        for relative in (".local/node/bin", ".hermes/node/bin"):
            with self.subTest(relative=relative):
                home = self.home / relative.replace("/", "-")
                directory = self.node_at(home / relative)
                resolved = self.installer.installer_environment({"PATH": ""}, home)
                self.assertEqual(resolved["PATH"], str(directory))

    def test_resolving_the_environment_twice_does_not_duplicate_path_entries(self):
        self.node_at(self.home / ".local/bin")
        first = self.installer.installer_environment({"PATH": ""}, self.home)
        self.assertEqual(self.installer.installer_environment(first, self.home), first)

    def test_missing_node_fails_before_install_or_staging(self):
        environment = dict(os.environ, PATH="/fixture/no-node")
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.object(self.installer.shutil, "which", return_value=None), \
                mock.patch.object(self.installer, "install") as install, \
                mock.patch.object(self.installer.sys, "argv", ["install.py", "--home", str(self.home)]), \
                mock.patch("sys.stderr") as stderr:
            self.assertEqual(self.installer.main(), 1)
        install.assert_not_called()
        message = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn("Node.js is required", message)
        self.assertIn("add its bin directory to PATH", message)
        self.assertIn("Searched PATH=", message)
        self.assertFalse((self.home / ".local/share/pi-pool").exists())

    def test_main_uses_current_users_home_and_shares_resolved_environment_with_install(self):
        resolved = dict(os.environ, PATH="/fixture/resolved")
        with mock.patch.object(self.installer, "installer_environment", return_value=resolved) as resolve, \
                mock.patch.object(self.installer, "install", side_effect=lambda *args: {"path": os.environ["PATH"]}) as install, \
                mock.patch.dict(os.environ), \
                mock.patch.object(self.installer.sys, "argv", ["install.py", "--home", str(self.home)]), \
                mock.patch("sys.stdout") as stdout:
            self.assertEqual(self.installer.main(), 0)
        self.assertEqual(resolve.call_args.args[1], Path.home())
        install.assert_called_once_with(self.home, "HEAD", None)
        self.assertIn("/fixture/resolved", "".join(call.args[0] for call in stdout.write.call_args_list))

    def test_status_and_rollback_do_not_require_node(self):
        for command in ("status", "rollback"):
            with self.subTest(command=command), \
                    mock.patch.object(self.installer, "installer_environment") as resolve, \
                    mock.patch.object(self.installer, command, return_value={}), \
                    mock.patch.object(self.installer.sys, "argv", ["install.py", command]), \
                    mock.patch("sys.stdout"):
                self.assertEqual(self.installer.main(), 0)
                resolve.assert_not_called()


class MacPython(unittest.TestCase):
    """10-18: launchd refuses the Command Line Tools Python access to ~/Documents, where the Mac checkout lives."""

    def test_a_flip_restarts_pi_pool_serve_only_when_it_runs(self):
        installer = load_installer()
        for active, expect in ((0, ["is-active", "restart"]), (3, ["is-active"])):
            with self.subTest(active=active):
                calls = []

                def run(argv, **kw):
                    calls.append(argv[2])
                    return subprocess.CompletedProcess(argv, active if argv[2] == "is-active" else 0, "", "")
                with mock.patch.object(installer, "systemd_user", return_value=True), \
                        mock.patch.object(installer.subprocess, "run", side_effect=run):
                    installer.restart_hookd(Path(tempfile.mkdtemp(prefix="pi-pool-units-")))
                self.assertEqual(calls, expect)

    def test_macos_reruns_under_homebrew_python(self):
        installer = load_installer()
        yes = lambda path: True
        self.assertEqual(installer.mac_python("Darwin", "/usr/bin/python3", yes), "/opt/homebrew/bin/python3")
        self.assertIsNone(installer.mac_python("Darwin", "/opt/homebrew/bin/python3", yes))
        self.assertIsNone(installer.mac_python("Darwin", "/usr/bin/python3", lambda path: False))
        self.assertIsNone(installer.mac_python("Linux", "/usr/bin/python3", yes))


if __name__ == "__main__":
    unittest.main()

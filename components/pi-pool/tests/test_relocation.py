import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = Path(__file__).resolve().parents[1]


class RelocatedSource(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pi-pool-relocated-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "checkout with spaces" / "pi-pool"
        self.source.mkdir(parents=True)
        shutil.copy2(SOURCE / "vend.py", self.source / "vend.py")
        for directory in ("app", "bin"):
            shutil.copytree(SOURCE / directory, self.source / directory,
                            ignore=shutil.ignore_patterns("__pycache__"))
        self.home = self.root / "home"
        self.state = self.root / "state"
        self.agent = self.home / ".prime" / "agent"
        self.prime = self.root / "prime-agent"
        self.bundle = self.prime / "dist" / "bundle"
        for directory in (self.state, self.agent, self.bundle):
            directory.mkdir(parents=True)
        (self.prime / "package.json").write_text('{"version":"fixture","type":"module"}')
        guard_dir = self.root / "isolation"
        shutil.copytree(SOURCE / "tests" / "isolation", guard_dir,
                        ignore=shutil.ignore_patterns("__pycache__"))
        inherited = {key: os.environ[key] for key in ("PATH", "NODE_OPTIONS", "PI_POOL_TEST_ISOLATION_LOG")
                     if key in os.environ}
        self.env = {**inherited, "HOME": str(self.home), "PI_POOL_DIR": str(self.state),
                    "PYTHONPATH": str(guard_dir),
                    "PRIME_AGENT_CODING_AGENT_DIR": str(self.agent),
                    "PI_POOL_PRIME_AGENT_ROOT": str(self.prime),
                    "PYTHONDONTWRITEBYTECODE": "1"}
        environment = patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)

    def snapshot(self):
        return {str(path.relative_to(self.source)): path.read_bytes()
                for path in self.source.rglob("*") if path.is_file()}

    def run_command(self, command, env=None, expected=0):
        result = subprocess.run(command, env=env or self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout

    def load(self, path, name):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {name: module}):
            spec.loader.exec_module(module)
        return module

    def test_wrappers_resolve_source_through_file_and_directory_links(self):
        before = self.snapshot()
        local = self.home / ".local" / "bin"
        local.mkdir(parents=True)
        (local / "pi-pool").symlink_to(self.source / "bin" / "pi-pool")
        (self.state / "bin").symlink_to(self.source / "bin", target_is_directory=True)
        (self.state / "vend.py").symlink_to(self.source / "vend.py")
        commands = [
            [str(self.source / "bin" / "pi-pool")],
            [str(local / "pi-pool")],
            [str(self.state / "bin" / "pi-pool-token"), "--cli"],
            [sys.executable, "-B", str(self.state / "vend.py"), "--cli"],
        ]
        for value, command in enumerate(commands, 10):
            self.run_command([*command, "set", "session_penalty", str(value)])
            self.assertEqual(json.loads((self.state / "config.json").read_text()),
                             {"session_penalty": value})
        self.assertEqual(self.snapshot(), before)

    def test_default_state_root_is_under_home_not_source(self):
        default_state = self.home / ".config" / "pi-pool"
        default_state.mkdir(parents=True)
        env = {key: value for key, value in self.env.items() if key != "PI_POOL_DIR"}
        before = self.snapshot()
        self.run_command([str(self.source / "bin" / "pi-pool"), "set", "session_penalty", "17"], env)
        self.assertEqual(json.loads((default_state / "config.json").read_text()),
                         {"session_penalty": 17})
        self.assertFalse((self.state / "config.json").exists())
        self.assertEqual(self.snapshot(), before)

    def test_enable_quotes_source_command_and_keeps_state_outside_checkout(self):
        before = self.snapshot()
        self.run_command([str(self.source / "bin" / "pi-pool"), "enable", "openai-codex"])
        models = json.loads((self.agent / "models.json").read_text())
        command = models["providers"]["openai-codex"]["apiKey"]
        self.assertEqual(shlex.split(command[1:]),
                         [str(self.source / "bin" / "pi-pool-token"), "--provider", "openai-codex"])
        self.assertTrue((self.state / "pi-pool.log").is_file())
        self.assertEqual(self.snapshot(), before)

    def test_vend_state_paths_do_not_follow_the_install_link(self):
        (self.state / "vend.py").symlink_to(self.source / "vend.py")
        vend = self.load(self.state / "vend.py", "relocated_vend")
        self.assertEqual(Path(vend.CODE_ROOT), self.source)
        before = self.snapshot()
        with vend.Flock(vend.LOCK):
            vend.save_json(vend.STATE, {"version": 2})
            vend.journal_write("synthetic", {"fixture": True})
            vend.log("relocation_test")
        for name in ("STATE", "LOCK", "LOG", "CONFIG", "FALLBACK", "JOURNAL"):
            self.assertEqual(os.path.commonpath([getattr(vend, name), str(self.state)]), str(self.state))
        self.assertTrue((self.state / "rotations" / "synthetic.json").is_file())
        self.assertEqual(self.snapshot(), before)

    def test_account_completions_return_items_from_both_pools(self):
        tokenmaxxing = self.home / ".config" / "tokenmaxxing"
        tokenmaxxing.mkdir(parents=True)
        (tokenmaxxing / "accounts.json").write_text(json.dumps({"version": 2, "accounts": [
            {"id": "synthetic-claude", "label": "claude", "email": "claude@example.test", "windows": []}
        ]}))
        (tokenmaxxing / "codex-accounts.json").write_text(json.dumps({"version": 2, "accounts": [
            {"id": "synthetic-codex", "label": "codex", "email": "codex@example.test", "windows": []}
        ]}))
        before = self.snapshot()
        script = """import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: extension } = await import(pathToFileURL(process.argv[1]));
let command;
extension({ on() {}, registerCommand(name, options) { assert.equal(name, 'account'); command = options; } });
assert.deepEqual(await command.getArgumentCompletions(''), [
  { value: 'claude@example.test', label: 'claude@example.test' },
  { value: 'codex@example.test', label: 'codex@example.test' },
  { value: 'follow', label: 'follow' },
]);
"""
        self.run_command(["node", "--input-type=module", "-e", script,
                          str(self.source / "app" / "extension" / "index.ts")])
        self.assertEqual(self.snapshot(), before)

    def test_state_root_inside_source_is_rejected_before_writes(self):
        for state in (self.source, self.source / "runtime"):
            env = {**self.env, "PI_POOL_DIR": str(state)}
            before = self.snapshot()
            for command in (
                [str(self.source / "bin" / "pi-pool"), "set", "session_penalty", "17"],
            ):
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("PI_POOL_DIR must be outside", result.stderr)
            self.assertEqual(self.snapshot(), before)

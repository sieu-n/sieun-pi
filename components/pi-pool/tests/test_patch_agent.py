import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

from fixture_isolation import isolate_test_module


SOURCE = Path(__file__).resolve().parents[1]


def setUpModule():
    isolate_test_module()


class PatchAgentGenerator(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pi-pool-launch-agent-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.state = self.root / "state"
        self.app = self.root / "checkout with spaces" / "pi-pool" / "app"
        self.app.mkdir(parents=True)
        self.script = self.app / "install_patch_agent.py"
        shutil.copy2(SOURCE / "app" / "install_patch_agent.py", self.script)
        self.marker = self.root / "patcher-executed"
        (self.app / "patch_prime_agent.py").write_text(
            "from pathlib import Path\nPath(" + repr(str(self.marker)) + ").touch()\n")
        (self.app / "pi-pool-status.js").write_text("export const fixture = 1;\n")
        self.runtime_app = self.home / ".local" / "share" / "sieun-pi" / "pool-patch" / "app"
        self.prime = self.root / "node_modules" / "prime-agent"
        (self.prime / "dist" / "bundle").mkdir(parents=True)
        (self.prime / "package.json").write_text('{"name":"prime-agent","version":"0.9.4"}')
        cli = self.prime / "dist" / "bundle" / "cli.js"
        cli.write_text("#!/usr/bin/env node\n")
        cli.chmod(0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "prime-agent").symlink_to(cli)
        inherited = {key: os.environ[key] for key in ("NODE_OPTIONS", "PI_POOL_TEST_ISOLATION_LOG", "PYTHONPATH")
                     if key in os.environ}
        self.env = {**inherited, "HOME": str(self.home), "PI_POOL_DIR": str(self.state),
                    "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", os.defpath),
                    "PYTHONDONTWRITEBYTECODE": "1"}
        self.destination = self.home / "Library" / "LaunchAgents" / "com.sieun.pi-pool-patch.plist"

    def run_generator(self, *args, env=None, script=None, expected=0):
        result = subprocess.run([sys.executable, "-B", str(script or self.script), *args],
                                env=env or self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertFalse(self.marker.exists(), "generator must not execute the patcher")
        return result

    def test_dry_run_resolves_source_home_path_and_watched_package(self):
        result = self.run_generator()
        data = plistlib.loads(result.stdout.encode())
        self.assertEqual(data["Label"], "com.sieun.pi-pool-patch")
        self.assertEqual(data["ProgramArguments"], ["/bin/sh", "-c",
            "sleep 20; exec /usr/bin/python3 -B " + shlex.quote(str(self.runtime_app / "patch_prime_agent.py")) + " apply --bundle-only"])
        self.assertEqual(data["EnvironmentVariables"], {
            "HOME": str(self.home), "PATH": self.env["PATH"], "PI_POOL_DIR": str(self.state),
            "PI_POOL_PRIME_AGENT_ROOT": str(self.prime),
            "PRIME_AGENT_CODING_AGENT_DIR": str(self.home / ".prime" / "agent"),
        })
        self.assertEqual(data["WatchPaths"], [str(self.prime.parent), str(self.prime / "package.json")])
        self.assertEqual((data["StartInterval"], data["RunAtLoad"], data["ThrottleInterval"]), (1800, True, 30))
        self.assertEqual(data["StandardOutPath"], str(self.state / "patch.out.log"))
        self.assertEqual(data["StandardErrorPath"], str(self.state / "patch.err.log"))
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertFalse(self.state.exists())
        self.assertFalse(self.runtime_app.exists())

    def test_write_installs_allowlisted_runtime_and_is_repeatable(self):
        output = self.run_generator("--write", "--prime-root", str(self.prime))
        self.assertEqual(output.stdout.strip(), str(self.destination))
        first = self.destination.read_bytes()
        paths = [self.destination, *self.runtime_app.iterdir()]
        mtimes = {path: path.stat().st_mtime_ns for path in paths}
        self.run_generator("--write", "--prime-root", str(self.prime))
        self.assertEqual(self.destination.read_bytes(), first)
        self.assertEqual({path: path.stat().st_mtime_ns for path in paths}, mtimes)
        self.assertEqual(sorted(path.name for path in self.runtime_app.iterdir()),
                         ["patch_prime_agent.py", "pi-pool-status.js"])
        for path in self.runtime_app.iterdir():
            self.assertEqual(path.read_bytes(), (self.app / path.name).read_bytes())
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])
        self.assertEqual(list(self.state.iterdir()), [])

    def test_symlinked_generator_names_the_generated_patcher(self):
        link = self.root / "linked-app"
        link.symlink_to(self.app, target_is_directory=True)
        output = self.run_generator(script=link / "install_patch_agent.py")
        self.assertIn(shlex.quote(str(self.runtime_app / "patch_prime_agent.py")),
                      plistlib.loads(output.stdout.encode())["ProgramArguments"][2])

    def test_invalid_prime_root_does_not_write(self):
        result = self.run_generator("--write", "--prime-root", str(self.root / "missing"), expected=2)
        self.assertIn("must contain Prime Agent package.json", result.stderr)
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.state.exists())

    def test_source_state_is_rejected_without_writes(self):
        result = self.run_generator("--write", env={**self.env, "PI_POOL_DIR": str(self.app.parent)}, expected=2)
        self.assertIn("must be outside", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_existing_symlink_is_not_overwritten(self):
        self.destination.parent.mkdir(parents=True)
        target = self.root / "do-not-change"
        target.write_text("original")
        self.destination.symlink_to(target)
        result = self.run_generator("--write", expected=2)
        self.assertIn("refusing to replace a symlink", result.stderr)
        self.assertEqual(target.read_text(), "original")

    def test_write_refreshes_only_the_two_runtime_files(self):
        self.run_generator("--write")
        (self.app / "extension").mkdir()
        (self.app / "extension" / "index.ts").write_text("not part of the service")
        (self.app / "ignored.json").write_text('{"fixture":true}')
        (self.app / "pi-pool-status.js").write_text("export const fixture = 2;\n")
        (self.app / "patch_prime_agent.py").write_text("raise SystemExit('must not run during install')\n")
        self.run_generator("--write")
        self.assertEqual(sorted(path.name for path in self.runtime_app.iterdir()),
                         ["patch_prime_agent.py", "pi-pool-status.js"])
        for path in self.runtime_app.iterdir():
            self.assertEqual(path.read_bytes(), (self.app / path.name).read_bytes())

    def test_unknown_runtime_entry_stops_before_install(self):
        self.runtime_app.mkdir(parents=True)
        unknown = self.runtime_app / "unexpected.json"
        unknown.write_text('{"fixture":true}')
        result = self.run_generator("--write", expected=2)
        self.assertIn("unexpected patch runtime entry", result.stderr)
        self.assertEqual(list(self.runtime_app.iterdir()), [unknown])
        self.assertFalse(self.destination.exists())

    def test_symlinked_runtime_stops_before_install(self):
        self.runtime_app.parent.mkdir(parents=True)
        target = self.root / "unowned"
        target.mkdir()
        self.runtime_app.symlink_to(target, target_is_directory=True)
        result = self.run_generator("--write", expected=2)
        self.assertIn("refusing a symlinked patch runtime", result.stderr)
        self.assertEqual(list(target.iterdir()), [])
        self.assertFalse(self.destination.exists())

    def test_runtime_cannot_contain_state(self):
        result = self.run_generator("--write", env={**self.env, "PI_POOL_DIR": str(self.runtime_app.parent)}, expected=2)
        self.assertIn("PI_POOL_DIR must be outside the generated patch runtime", result.stderr)
        self.assertFalse(self.runtime_app.exists())

    def test_generated_patcher_runs_without_source_or_extension_access(self):
        shutil.copy2(SOURCE / "app" / "patch_prime_agent.py", self.app / "patch_prime_agent.py")
        self.run_generator("--write")
        self.app.parent.rename(self.root / "moved-source")
        extension = self.home / ".prime" / "agent" / "extensions" / "pi-pool"
        extension.mkdir(parents=True)
        (extension / "keep").write_text("existing extension")
        bundle = self.prime / "dist" / "bundle" / "fixture.js"
        bundle.write_text("// generated-runtime-fixture\nconst value = 1;\n")
        probe = self.root / "probe.py"
        probe.write_text("""import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('generated_patcher', sys.argv[1])
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)
patcher.TARGETS = [{'id': 'fixture', 'needle': '// generated-runtime-fixture', 'helper': True,
                   'patches': [('value', 'const value = 1;', 'const value = 2; /* pi-pool */')]}]
def forbidden():
    raise AssertionError('bundle-only accessed extension configuration')
for name in ('agent_dir', 'extension_state', 'extension_paths', 'ensure_extension_link', 'remove_extension_link'):
    setattr(patcher, name, forbidden)
assert patcher.main(['apply', '--bundle-only']) == 0
assert patcher.main(['apply', '--bundle-only']) == 0
assert patcher.main(['--check', '--bundle-only']) == 0
assert Path(patcher.HELPER_SRC).parent == Path(sys.argv[1]).parent
""")
        env = {**self.env, "PI_POOL_PRIME_AGENT_ROOT": str(self.prime)}
        result = subprocess.run([sys.executable, "-B", str(probe), str(self.runtime_app / "patch_prime_agent.py")],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("const value = 2;", bundle.read_text())
        self.assertEqual((bundle.parent / "pi-pool-status.js").read_bytes(),
                         (self.runtime_app / "pi-pool-status.js").read_bytes())
        self.assertEqual((extension / "keep").read_text(), "existing extension")
        self.assertEqual(list(extension.iterdir()), [extension / "keep"])
        self.assertTrue((self.state / "pi-pool.log").is_file())
        self.assertEqual(sorted(path.name for path in self.runtime_app.iterdir()),
                         ["patch_prime_agent.py", "pi-pool-status.js"])

    def test_runtime_path_in_documents_is_rejected(self):
        documents = self.home / "Documents" / "generated"
        documents.mkdir(parents=True)
        self.runtime_app.parent.parent.mkdir(parents=True)
        self.runtime_app.parent.symlink_to(documents, target_is_directory=True)
        result = self.run_generator("--write", expected=2)
        self.assertIn("generated patch runtime must be outside Documents", result.stderr)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(documents.iterdir()), [])

    def test_allowlisted_filename_cannot_be_a_symlink(self):
        self.runtime_app.mkdir(parents=True)
        helper = self.app / "pi-pool-status.js"
        (self.runtime_app / helper.name).symlink_to(helper)
        before = helper.read_bytes()
        result = self.run_generator("--write", expected=2)
        self.assertIn("unexpected patch runtime entry", result.stderr)
        self.assertEqual(helper.read_bytes(), before)
        self.assertFalse(self.destination.exists())

"""install.py against a throwaway git checkout and HOME: what ships, the links,
the atomic flip, rollback, and the two refusals."""
import json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


INSTALLER = Path(__file__).resolve().parents[1] / "install.py"
HOOK = """#!/bin/sh
[ -e "$PI_POOL_DIR/hook-fails" ] && grep -q "$(cat "$PI_POOL_DIR/hook-fails")" "$(dirname "$0")/../vend.py" && exit 3
printf 'fixture-token-%s' 0123456789abcdefghij
"""


class Install(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="pi-pool-install-"))
        self.addCleanup(self.cleanup)
        self.repo, self.home = self.base / "checkout", self.base / "home"
        self.home.mkdir()
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

    def run_installer(self, *args):
        done = subprocess.run(["/usr/bin/python3", "-B", str(self.repo / "components/pi-pool/install.py"), *args,
                               "--home", str(self.home)], capture_output=True, text=True)
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
        (self.home / ".config/pi-pool").mkdir(parents=True)
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

    def test_a_first_install_whose_hook_fails_puts_the_old_links_back(self):
        (self.home / ".config/pi-pool").mkdir(parents=True)
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


if __name__ == "__main__":
    unittest.main()

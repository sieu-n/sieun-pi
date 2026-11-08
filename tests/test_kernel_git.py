"""Kernel git wrapper (packages/sieun-rules/src/kernel-git.py and git-child/git): on the owner's Mac a kernel's git grep skips binary files.

On 2026-11-08 at 15:49:30Z a take-in.mjs git grep held 41.94 GB on the Mac. On 11-09 the cause measured as Apple Git's regex match of
binary files under a UTF-8 locale: one 4.8 MB .otf took 110 MB, and -I kept the greps over apps/ at 23 to 28 MB. Without kernel-git.py
these cases fail, because the file is missing and a kernel's git grep still lists binary files.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GIT_FILE = REPO / "packages" / "sieun-rules" / "src" / "kernel-git.py"
GIT_DIR = REPO / "packages" / "sieun-rules" / "src" / "git-child"
PRELUDE = REPO / "packages" / "sieun-rules" / "src" / "kernel-guard.ts"


def loaded(base: dict, platform: str = "darwin") -> dict:
    """The environment after kernel-git.py runs in a kernel on `platform` whose environment was base."""
    saved, saved_platform = dict(os.environ), sys.platform
    try:
        os.environ.clear()
        os.environ.update(base)
        sys.platform = platform
        exec(compile(GIT_FILE.read_text(), str(GIT_FILE), "exec"), {"__name__": "global_rules_kernel_git", "__file__": str(GIT_FILE)})
        return dict(os.environ)
    finally:
        sys.platform = saved_platform
        os.environ.clear()
        os.environ.update(saved)


def peak_kb(argv: list, env: dict, cwd: str) -> int:
    """The peak RSS of argv and its children in KB, read from /usr/bin/time -l on macOS."""
    done = subprocess.run(["/usr/bin/time", "-l", *argv], env=env, cwd=cwd, capture_output=True, text=True, timeout=120)
    line = next(l for l in done.stderr.splitlines() if "maximum resident set size" in l)
    return int(line.split()[0]) // 1024


@unittest.skipUnless(shutil.which("git"), "needs git")
class KernelGit(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.repo = Path(self.tmp) / "repo"
        self.repo.mkdir()
        base = {k: v for k, v in os.environ.items() if k != "SIEUN_RULES_REAL_GIT"}
        self.real = shutil.which("git")
        self.env = loaded(base)
        git = lambda *a: subprocess.run([self.real, "-C", str(self.repo), *a], check=True, capture_output=True, env=base)
        git("init", "-q")
        (self.repo / "text.txt").write_text("const tokenXYZ = 1;\n")
        (self.repo / "blob.bin").write_bytes(b"\x00\x01\x02 tokenXYZ \x00" * 64)
        git("add", ".")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], env=self.env, cwd=self.repo, capture_output=True, text=True, timeout=30)

    def test_the_wrapper_comes_first_on_path_and_names_the_real_git(self) -> None:
        self.assertEqual(self.env["PATH"].split(os.pathsep)[0], str(GIT_DIR))
        self.assertEqual(self.env["SIEUN_RULES_REAL_GIT"], self.real)
        self.assertEqual(loaded(self.env)["PATH"], self.env["PATH"])

    def test_a_regex_git_grep_skips_binary_files(self) -> None:
        self.assertEqual(self.git("grep", "-l", "token.YZ").stdout.split(), ["text.txt"])
        self.assertEqual(self.git("-C", str(self.repo), "-c", "core.quotePath=false", "grep", "-l", "-w", "-E", "tokenXYZ|none").stdout.split(),
                         ["text.txt"])
        self.assertEqual(self.git("grep", "-l", "token.YZ", "HEAD").stdout.split(), ["HEAD:text.txt"])

    def test_a_later_text_flag_still_searches_binary_files(self) -> None:
        self.assertEqual(sorted(self.git("grep", "-l", "-a", "token.YZ").stdout.split()), ["blob.bin", "text.txt"])

    def test_other_git_commands_pass_through_unchanged(self) -> None:
        self.assertEqual(self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "grep").returncode, 0)
        self.assertEqual(self.git("log", "-1", "--format=%s").stdout.strip(), "grep")
        self.assertEqual(self.git("log", "--grep", "one", "--format=%s").stdout.strip(), "one")

    def test_other_hosts_keep_their_path(self) -> None:
        base = {k: v for k, v in os.environ.items() if k != "SIEUN_RULES_REAL_GIT"}
        self.assertEqual(loaded(base, "linux")["PATH"], base["PATH"])

    def test_the_kernel_prelude_loads_kernel_git(self) -> None:
        self.assertTrue("kernel-git.py" in PRELUDE.read_text(), "kernel-guard.ts does not load kernel-git.py")

    @unittest.skipUnless(sys.platform == "darwin", "Apple Git's binary-file regex cost exists only on macOS")
    def test_a_regex_grep_over_a_binary_file_stays_small_on_the_mac(self) -> None:
        (self.repo / "font.bin").write_bytes(os.urandom(5 * 1024 * 1024))
        subprocess.run([self.real, "-C", str(self.repo), "add", "font.bin"], check=True)
        env = {**self.env, "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
        raw = peak_kb([self.real, "grep", "-l", "extract.earerToken"], env, str(self.repo))
        wrapped = peak_kb(["git", "grep", "-l", "extract.earerToken"], env, str(self.repo))
        print(f"\nApple Git regex grep of a 5 MB binary file: {raw} MB as is, {wrapped} MB through git-child/git", file=sys.stderr)
        self.assertLess(wrapped, 40)


if __name__ == "__main__":
    unittest.main()

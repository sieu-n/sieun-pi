"""Run-time wiki walk guard (global AGENTS.md rule 6): packages/sieun-rules/src/kernel-walk.py, and walk.ts through the kernel's shell check.

On 11-04 'wiki list numbering fix 11-04' ran `glob.glob(root + '**/*.html', recursive=True)` with root the wiki content root and a
trailing slash for 56 min, and 'wiki identical write no-op 11-04' ran `glob.glob(root + '/**/*.html', recursive=True)` for 24 min.
Each case runs a fresh Python process with HOME set to a small fake tree, loads kernel-walk.py the way kernel-guard.ts does, and runs
cells compiled as "<cell-N>". Without kernel-walk.py every refusal case fails.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_kernel_send_guard import KernelGuardBase

REPO = Path(__file__).resolve().parents[1]
WALK = REPO / "packages" / "sieun-rules" / "src" / "kernel-walk.py"

RUNNER = r"""
import json, linecache, os, sys
spec = json.loads(sys.stdin.read())
sys.path.insert(0, spec["lib"])
walk = spec["walk"]
exec(compile(open(walk).read(), walk, "exec"), {"__name__": "global_rules_kernel_walk", "__file__": walk})
scope = {"__name__": "__main__", "RESULT": None}
out = {"error": None}
try:
    for n, code in enumerate(spec["cells"], 1):
        name = f"<cell-{n}>"
        linecache.cache[name] = (len(code), None, code.splitlines(True), name)
        exec(compile(code, name, "exec"), scope)
except BaseException as error:
    out["error"] = f"{type(error).__name__}: {error}"
out["result"] = scope.get("RESULT")
print("\n" + json.dumps(out, default=str))
"""

PAGES = {
    "index.html": "",
    "apps/a.html": "<pre class=mermaid>",
    "apps/sub/b.html": "",
    "domains/d.html": "<pre class=mermaid>",
    "sessions/2026/11/04/s.html": "<pre class=mermaid>",
    "agents/vent/y.html": "",
}

TODAY_NUMBERING_FIX = "import glob, os\nroot = os.path.expanduser('~/.pi/wiki/content/')\nRESULT = len(glob.glob(root + '**/*.html', recursive=True))\n"
TODAY_IDENTICAL_WRITE = "import glob, os\nroot = os.path.expanduser('~/.pi/wiki/content')\nRESULT = len(glob.glob(root + '/**/*.html', recursive=True))\n"


class WalkBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.home = self.tmp / "home"
        self.content = self.home / ".pi" / "wiki" / "content"
        for path, text in PAGES.items():
            (self.content / path).parent.mkdir(parents=True, exist_ok=True)
            (self.content / path).write_text(text)
        (self.home / "notes").mkdir()
        (self.home / "notes" / "auth.json").write_text("{}")
        self.lib = self.tmp / "lib"
        self.lib.mkdir()
        (self.lib / "libwalk.py").write_text("import glob\ndef count(root):\n    return len(glob.glob(root + '/**/*.html', recursive=True))\n")

    def run_cells(self, *cells):
        env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONSTARTUP"}}
        env["HOME"] = str(self.home)
        spec = json.dumps({"walk": str(WALK), "lib": str(self.lib), "cells": list(cells)})
        proc = subprocess.run([sys.executable, "-B", "-c", RUNNER], input=spec, capture_output=True, text=True, cwd=self.tmp, env=env, timeout=60)
        lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
        self.assertTrue(lines, f"runner gave no result\nstdout: {proc.stdout}\nstderr: {proc.stderr}")
        return json.loads(lines[-1])

    def assert_refused(self, out):
        self.assertIsNotNone(out["error"], f"not refused: {out}")
        self.assertIn("WalkRefused: global-rules wiki walk guard", out["error"])
        self.assertIn("/wiki/api/agent/find", out["error"])
        self.assertIn("~/.pi/wiki/content/apps/**/*.html", out["error"])

    def assert_passed(self, out, result):
        self.assertIsNone(out["error"], out)
        self.assertEqual(out["result"], result)


class PythonWalks(WalkBase):
    def test_todays_glob_with_a_trailing_slash_root_is_refused(self):
        self.assert_refused(self.run_cells(TODAY_NUMBERING_FIX))

    def test_todays_glob_with_a_slash_before_the_stars_is_refused(self):
        self.assert_refused(self.run_cells(TODAY_IDENTICAL_WRITE))

    def test_other_whole_walks_of_the_content_root_or_home_are_refused(self):
        for cell in (
            "import glob, os\nRESULT = list(glob.iglob(os.path.expanduser('~/.pi/wiki/content/*/**/*.html'), recursive=True))\n",
            "import glob, os\nRESULT = glob.glob('**/*.html', root_dir=os.path.expanduser('~/.pi/wiki/content'), recursive=True)\n",
            "import os\nRESULT = sum(len(f) for _, _, f in os.walk(os.path.expanduser('~/.pi/wiki/content')))\n",
            "import os\nRESULT = list(os.walk(os.path.expanduser('~/.pi/wiki/content'), topdown=False))\n",
            "from pathlib import Path\nRESULT = len(list(Path('~/.pi/wiki/content').expanduser().rglob('*.html')))\n",
            "from pathlib import Path\nRESULT = len(list(Path.home().glob('**/auth.json')))\n",
            "import glob\nRESULT = glob.glob('/home/sieun/**/codex*/auth.json'.replace('/home/sieun', __import__('os').path.expanduser('~')), recursive=True)\n",
            "import os\nRESULT = [d for d, _, _ in os.walk(os.path.expanduser('~'))]\n",
            "import os\nRESULT = [d for d, _, _ in os.walk(os.path.expanduser('~/.pi'))]\n",
        ):
            with self.subTest(cell=cell):
                self.assert_refused(self.run_cells(cell))

    def test_a_walk_of_one_named_subfolder_passes(self):
        root = "import glob, os\nroot = os.path.expanduser('~/.pi/wiki/content')\n"
        self.assert_passed(self.run_cells(root + "RESULT = len(glob.glob(root + '/apps/**/*.html', recursive=True))\n"), 2)
        self.assert_passed(self.run_cells(
            root + "RESULT = sum(len(glob.glob(f'{root}/{d}/**/*.html', recursive=True)) for d in ('apps', 'domains', 'projects', 'experiments'))\n"
        ), 3)
        self.assert_passed(self.run_cells(root + "RESULT = sum(len(f) for _, _, f in os.walk(root + '/apps'))\n"), 2)
        self.assert_passed(self.run_cells("from pathlib import Path\nRESULT = len(list((Path.home() / 'notes').rglob('*.json')))\n"), 1)

    def test_a_top_level_listing_and_a_walk_pruned_to_curated_folders_pass(self):
        root = "import glob, os\nroot = os.path.expanduser('~/.pi/wiki/content')\n"
        self.assert_passed(self.run_cells(root + "RESULT = sorted(next(os.walk(root))[1])\n"), ["agents", "apps", "domains", "sessions"])
        self.assert_passed(self.run_cells(root + "RESULT = len(glob.glob(root + '/*'))\n"), 5)
        self.assert_passed(self.run_cells(
            root + "RESULT = 0\nfor d, dirs, files in os.walk(root):\n    if d == root:\n        dirs[:] = [x for x in dirs if x in ('apps', 'domains')]\n        continue\n    RESULT += len(files)\n"
        ), 3)

    def test_a_walk_in_library_code_is_not_judged(self):
        self.assert_passed(self.run_cells("import os, libwalk\nRESULT = libwalk.count(os.path.expanduser('~/.pi/wiki/content'))\n"), 6)


class ShellWalksTheKernelStarts(KernelGuardBase):
    """A find, rg or grep -r the kernel starts with a root built at run time, judged by walk.ts through send-check.ts."""

    def setUp(self):
        super().setUp()
        self.content = self.tmp / "home" / ".pi" / "wiki" / "content"
        for path, text in PAGES.items():
            (self.content / path).parent.mkdir(parents=True, exist_ok=True)
            (self.content / path).write_text(text)

    def test_an_rg_of_the_content_root_is_refused(self):
        out = self.run_cells("import os\nroot = os.path.expanduser('~/.pi/wiki/content')\nRESULT = (await bash(f'rg -l mermaid {root}')).stdout\n")
        self.assertIsNotNone(out["refused"], out)
        self.assertIn("wiki walk guard", out["refused"])

    def test_an_rg_of_curated_folders_runs(self):
        out = self.run_cells(
            "import os\nroot = os.path.expanduser('~/.pi/wiki/content')\n"
            "RESULT = sorted((await bash(f'rg -l mermaid {root}/apps {root}/domains')).stdout.split())\n"
        )
        self.assert_passed(out)
        self.assertEqual([Path(p).name for p in out["result"]], ["a.html", "d.html"])


if __name__ == "__main__":
    unittest.main()

"""Guard paths a kernel hands its children survive a prune of the release it loaded them from (packages/sieun-rules/src/release-path.py).

On 11-26 every pi-host kernel on the Mac and us-metal02 named pi-host/release-e7e0a88 in NODE_OPTIONS, in the send-check judge it starts, on
PYTHONPATH and on PATH. Without stable_path() a prune of that release breaks each Node child at preload and turns the send guard, the
transcript guard's systemd-run shim and the Mac's git grep wrapper off, so the case below finds paths that no longer exist.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = Path("packages/sieun-rules/src")
LOAD = """
import json, os, sys
src = sys.argv[1]
names = {"kernel-guard.py": "global_rules_send_guard", "kernel-read.py": "global_rules_kernel_read", "kernel-node.py": "global_rules_kernel_node",
         "kernel-git.py": "global_rules_kernel_git"}
seen = {}
for name, module in names.items():
    path = os.path.join(src, name)
    scope = {"__name__": module, "__file__": path}
    exec(compile(open(path).read(), path, "exec"), scope)
    seen.update({key: scope[key] for key in ("CHECK", "CHILD_DIR", "UNIT_ENV", "PRELOAD", "GIT_DIR") if key in scope})
seen["PYTHONPATH"] = os.environ.get("PYTHONPATH", "").split(os.pathsep)[0]
seen["PATH"] = os.environ.get("PATH", "").split(os.pathsep)[0]
print(json.dumps(seen))
"""


@unittest.skipUnless(shutil.which("node"), "needs node")
class ReleasePath(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_pi_host_kernel_keeps_its_guard_paths_after_its_release_is_pruned(self) -> None:
        host = self.tmp / "pi-host"
        for release in ("release-old", "release-new"):
            shutil.copytree(REPO / SRC, host / release / SRC, ignore=shutil.ignore_patterns("__pycache__"))
        (host / "current").symlink_to("release-new")
        env = {key: value for key, value in os.environ.items() if key not in ("NODE_OPTIONS", "PYTHONPATH")}
        done = subprocess.run([sys.executable, "-B", "-c", LOAD, str(host / "release-old" / SRC)], env=env, capture_output=True, text=True,
                              timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        seen = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual(set(seen), {"CHECK", "CHILD_DIR", "UNIT_ENV", "PRELOAD", "GIT_DIR", "PYTHONPATH", "PATH"})
        shutil.rmtree(host / "release-old")
        for key, path in seen.items():
            self.assertTrue(path.startswith(str(host / "current") + os.sep), f"{key} names {path}")
            self.assertTrue(os.path.exists(path), f"{key} names {path}, which the prune removed")


if __name__ == "__main__":
    unittest.main()

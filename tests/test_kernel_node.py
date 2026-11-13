"""Kernel node preload (packages/sieun-rules/src/kernel-node.py and node-child/epipe.cjs): a Node child of the kernel exits once its reader leaves.

On 2026-11-08 at 10:08Z `npx convex data ... 2>&1 | head -c 3000` grew to 4.36 GB on the owner's Mac, because the CLI's uncaughtException
handler kept the process alive after head closed the pipe. The writer here swallows uncaught errors the same way, so without kernel-node.py
it writes into the closed pipe until the timeout and the first case fails.
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NODE_FILE = REPO / "packages" / "sieun-rules" / "src" / "kernel-node.py"
PRELUDE = REPO / "packages" / "sieun-rules" / "src" / "kernel-guard.ts"
WRITER = """
process.on("uncaughtException", () => {});
setInterval(() => { process.stdout.write("x".repeat(65536)); process.stderr.write("y".repeat(65536)); }, 1);
"""
KEEPER = """
process.stderr.on("error", () => {});
let writes = 0;
const timer = setInterval(() => {
  process.stderr.write("y".repeat(65536));
  if (++writes === 50) { clearInterval(timer); require("fs").writeFileSync(process.argv[2], "alive"); }
}, 1);
"""


def loaded(base: dict) -> dict:
    """The environment after kernel-node.py runs in a kernel whose environment was base."""
    saved = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(base)
        exec(compile(NODE_FILE.read_text(), str(NODE_FILE), "exec"), {"__name__": "global_rules_kernel_node", "__file__": str(NODE_FILE)})
        return dict(os.environ)
    finally:
        os.environ.clear()
        os.environ.update(saved)


@unittest.skipUnless(shutil.which("node"), "needs node")
class KernelNode(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.writer = Path(self.tmp) / "writer.cjs"
        self.writer.write_text(WRITER)
        base = {k: v for k, v in os.environ.items() if k != "NODE_OPTIONS"}
        self.env = loaded(base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_writer_exits_once_head_closes_the_pipe(self) -> None:
        started = time.monotonic()
        done = subprocess.run(["sh", "-c", f'node "{self.writer}" 2>&1 | head -c 10 >/dev/null; echo "$?"'],
                              env=self.env, capture_output=True, text=True, timeout=20)
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(done.stdout.strip(), "0")

    def test_a_writer_that_handles_its_own_stream_errors_outlives_its_reader(self) -> None:
        # A detached Prime daemon worker ignores EPIPE on stderr to outlive its supervisor; on 11-13 the preload ended such workers.
        keeper = Path(self.tmp) / "keeper.cjs"
        keeper.write_text(KEEPER)
        alive = Path(self.tmp) / "alive"
        subprocess.run(["sh", "-c", f'node "{keeper}" "{alive}" 2>&1 >/dev/null | head -c 10 >/dev/null'], env=self.env,
                       capture_output=True, text=True, timeout=20)
        self.assertEqual(alive.read_text() if alive.exists() else "", "alive")

    def test_full_output_still_reaches_a_reader_that_stays(self) -> None:
        done = subprocess.run(["sh", "-c", "node -e 'console.log(\"a\".repeat(200000))' | wc -c"], env=self.env,
                              capture_output=True, text=True, timeout=20)
        self.assertEqual(done.stdout.strip(), "200001")

    def test_existing_node_options_stay_and_the_preload_is_added_once(self) -> None:
        base = {**self.env, "NODE_OPTIONS": "--max-old-space-size=2048"}
        once = loaded(base)["NODE_OPTIONS"]
        self.assertTrue(once.startswith("--max-old-space-size=2048 --require "))
        self.assertEqual(loaded({**base, "NODE_OPTIONS": once})["NODE_OPTIONS"], once)

    def test_the_kernel_prelude_loads_kernel_node(self) -> None:
        self.assertTrue("kernel-node.py" in PRELUDE.read_text(), "kernel-guard.ts does not load kernel-node.py")


if __name__ == "__main__":
    unittest.main()

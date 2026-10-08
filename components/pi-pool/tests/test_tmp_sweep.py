"""save_json removes the temp files that killed writers left next to the file it writes."""
import importlib.util, os, subprocess, sys, tempfile, unittest, unittest.mock

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["PI_POOL_DIR"] = tempfile.mkdtemp(prefix="pi-pool-sweep-")
_spec = importlib.util.spec_from_file_location("vend_sweep", os.path.join(SOURCE, "vend.py"))
vend = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = vend
with unittest.mock.patch.dict(os.environ, {"HOME": os.environ["PI_POOL_DIR"]}):
    _spec.loader.exec_module(vend)


def dead_pid():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


class SweepDeadWriters(unittest.TestCase):
    def test_a_save_removes_dead_writers_temp_files_and_keeps_the_rest(self):
        folder = tempfile.mkdtemp(prefix="pi-pool-sweep-")
        live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        dead = dead_pid()
        names = {
            f"state.json.tmp.{dead}": False,
            f"state.json.tmp.{live.pid}": True,
            "state.json.tmp.notapid": True,
            f"config.json.tmp.{dead}": True,
            f"state.json.{dead}": True,
        }
        for name in names:
            with open(os.path.join(folder, name), "w") as f:
                f.write("{")
        vend.save_json(os.path.join(folder, "state.json"), {"version": 2})
        left = set(os.listdir(folder))
        self.assertEqual(left, {"state.json", *(name for name, kept in names.items() if kept)})
        with open(os.path.join(folder, "state.json")) as f:
            self.assertEqual(f.read(), '{"version":2}')


if __name__ == "__main__":
    unittest.main()

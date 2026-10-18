import json, subprocess, tempfile, unittest
from pathlib import Path
import importlib.util
spec = importlib.util.spec_from_file_location('repl_guard', str(Path(__file__).resolve().parents[1] / 'repl_guard.py'))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

ORIG = "def f():\n    return 1\n"
GUARDED = "def f():\n    return 1\n\ndef _reopen_is_unsafe(mode):\n    return True\n"


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        g.WATCH = self.d
        self.repl = self.d / 'repl.py'
        a, b = self.d / 'a.py', self.d / 'b.py'
        a.write_text(ORIG); b.write_text(GUARDED)
        diff = subprocess.run(['diff', '-u', str(a), str(b)], capture_output=True, text=True).stdout
        self.patch = self.d / 'guard.patch'
        self.patch.write_text(diff)
        self.sent = []

    def run_check(self, py_ok=True, patches=None):
        def run(cmd, **kw):
            if cmd[0] == 'patch':
                return subprocess.run(cmd, **kw)
            return subprocess.CompletedProcess(cmd, 0 if py_ok else 1, '', '')
        return g.check(repl=self.repl, patches=patches or [self.patch], py=Path('/bin/true'), run=run,
                       send=lambda s, m: self.sent.append((s, m)), state_file=self.d / 'state.json')

    def test_guarded_file_is_left_alone(self):
        self.repl.write_text(GUARDED)
        self.assertEqual(self.run_check()['status'], 'ok')

    def test_rewritten_file_gets_the_guard_back(self):
        self.repl.write_text(ORIG)
        self.assertEqual(self.run_check()['status'], 'reapplied')
        self.assertIn('_reopen_is_unsafe', self.repl.read_text())
        self.assertEqual(self.sent, [])

    def test_the_older_patch_is_used_when_the_newer_one_does_not_fit(self):
        self.repl.write_text(ORIG)
        other = self.d / 'other.patch'
        other.write_text(subprocess.run(['diff', '-u', str(self.d / 'b.py'), str(self.d / 'a.py')], capture_output=True, text=True).stdout)
        self.assertEqual(self.run_check(patches=[other, self.patch])['status'], 'reapplied')
        self.assertIn('_reopen_is_unsafe', self.repl.read_text())

    def test_a_patch_that_does_not_apply_alerts_once(self):
        self.repl.write_text("something else entirely\n")
        first = self.run_check()
        self.assertEqual((first['status'], first.get('alerted')), ('failed', True))
        self.assertEqual(self.run_check()['status'], 'failed')
        self.assertEqual(len(self.sent), 1, 'one alert per repl.py version')

    def test_a_patch_that_breaks_the_import_is_rolled_back(self):
        self.repl.write_text(ORIG)
        res = self.run_check(py_ok=False)
        self.assertEqual(res['status'], 'failed')
        self.assertEqual(self.repl.read_text(), ORIG)


if __name__ == '__main__':
    unittest.main()

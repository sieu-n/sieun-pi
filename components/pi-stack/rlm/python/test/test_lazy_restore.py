from __future__ import annotations

import os
import tempfile
import unittest

from test_repl import ReplProcess, one

BIG = "big = [str(i) for i in range(200_000)]\nsmall = 7\ndef total():\n    return len(big)"


class LazyRestoreTest(unittest.TestCase):
    """Large restored records revive on first use instead of at restore."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.path = os.path.join(self.tmp, "kernel-state.dill")
        self.manifest = os.path.join(self.tmp, "kernel-state.json")
        source = self.kernel()
        self.assertEqual(one(source.execute("seed", BIG), "done")["status"], "ok")
        seeded = self.snapshot(source, "seed-snap")
        self.assertEqual(seeded["status"], "ok")
        self.seed_bytes = seeded["bytes"]
        source.close()

    def kernel(self) -> ReplProcess:
        repl = ReplProcess()
        self.addCleanup(repl.close)
        repl.ready()
        return repl

    def snapshot(self, repl: ReplProcess, rid: str, **options) -> dict:
        repl.send({"type": "snapshot", "id": rid, "path": self.path, "manifest_path": self.manifest, **options})
        return one(repl.until_done(rid), "done")

    def restore(self, repl: ReplProcess, rid: str = "restore") -> dict:
        repl.send({"type": "restore", "id": rid, "path": self.path})
        done = one(repl.until_done(rid), "done")
        self.assertEqual(done["status"], "ok")
        return done

    def result(self, repl: ReplProcess, rid: str, code: str) -> str:
        events = repl.execute(rid, code)
        error = one(events, "error")
        if error is not None:
            return f"{error['ename']}: {error['evalue']}"
        return one(events, "result")["text"][:200]

    def test_large_record_stays_on_disk_until_a_cell_reads_it(self):
        repl = self.kernel()
        repl.execute("b0", "import gc, sys\ngc.collect()\nb0 = sys.getallocatedblocks()")
        done = self.restore(repl)
        self.assertEqual(done["restored"], ["big", "small", "total"])
        self.assertEqual(self.result(repl, "b1", "gc.collect()\nsys.getallocatedblocks() - b0 < 50_000"), "True")
        self.assertEqual(self.result(repl, "names", "('big' in globals(), 'small' in globals())"), "(False, True)")
        self.assertEqual(self.result(repl, "use", "total()"), "200000")
        self.assertEqual(self.result(repl, "bound", "('big' in globals(), len(big))"), "(True, 200000)")

    def test_snapshot_carries_an_unread_record_verbatim(self):
        repl = self.kernel()
        self.restore(repl)
        repl.execute("f", "def later():\n    return small + 1")
        done = self.snapshot(repl, "resnap")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["saved"], ["big", "later", "small", "total"])
        self.assertLess(done["bytes"] - self.seed_bytes, 10_000)
        self.assertEqual(self.result(repl, "still", "len(big)"), "200000")
        fresh = self.kernel()
        self.restore(fresh)
        self.assertEqual(self.result(fresh, "read", "(len(big), later(), total())"), "(200000, 8, 200000)")

    def test_rebound_or_deleted_name_never_revives_its_old_record(self):
        repl = self.kernel()
        self.restore(repl)
        repl.execute("rebind", "big = 1\ndel big")
        self.assertEqual(self.result(repl, "gone", "big"), "NameError: name 'big' is not defined")
        done = self.snapshot(repl, "after")
        self.assertNotIn("big", done["saved"])

    def test_list_names_includes_unread_records(self):
        repl = self.kernel()
        self.restore(repl)
        repl.send({"type": "list_names", "id": "ln"})
        self.assertEqual(one(repl.until_done("ln"), "done")["names"], ["big", "small", "total"])

    def test_prune_drops_an_oversized_unread_record(self):
        repl = self.kernel()
        self.restore(repl)
        done = self.snapshot(repl, "prune", max_variable_bytes=100_000, prune_oversized=True)
        self.assertEqual(done["status"], "ok")
        # dill pickles total() with big inside it, so both records are oversized.
        self.assertEqual(done["pruned"], ["big", "total"])
        self.assertEqual(self.result(repl, "pruned", "big"), "NameError: name 'big' is not defined")

    def test_record_a_snapshot_cannot_carry_revives_before_its_source_is_replaced(self):
        repl = self.kernel()
        self.restore(repl)
        done = self.snapshot(repl, "tight", max_bytes=100_000)
        self.assertEqual(done["status"], "ok")
        self.assertNotIn("big", done["saved"])
        self.assertEqual(self.result(repl, "kept", "len(big)"), "200000")

    def test_unreadable_record_fails_its_lookup_with_the_reason(self):
        repl = self.kernel()
        self.restore(repl)
        with open(self.path, "ab") as fh:
            fh.write(b"changed")
        error = self.result(repl, "changed", "big")
        self.assertTrue(error.startswith("NameError: name 'big' could not be revived from the kernel snapshot"), error)
        self.assertEqual(self.result(repl, "small", "small"), "7")


if __name__ == "__main__":
    unittest.main()

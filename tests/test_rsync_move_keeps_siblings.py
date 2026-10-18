"""On 2026-10-18 from 04:27Z to 04:38Z a Mac job moved chats to us-metal02 with `rsync -aR --delete sessions/<chat>.jsonl
session-artifacts/<chat>/ box:~/.prime/agent/`. The Mac's /usr/bin/rsync was openrsync, which with -R and --delete deleted every other
chat in the box's sessions and session-artifacts (5,244 files of 5 chats plus box-only sessions). The fix makes plain `rsync` GNU rsync on
the Mac too. This test runs that exact command form with the rsync this PATH resolves and checks that sibling chats and their newer
box-owned files stay. Run it on each box: python3 -B -m unittest tests/test_rsync_move_keeps_siblings.py"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

MOVED = "01a1180e-6567-747f-bf44-452520ebdd1b"
SIBLINGS = ("01a14210-4e7d-72c3-aa67-e3d476f4e728", "01a14c31-cb24-76cb-bde3-940591cacd18")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class RsyncMoveKeepsSiblings(unittest.TestCase):
    def test_relative_delete_move_leaves_sibling_chats_untouched(self):
        rsync = shutil.which("rsync")
        self.assertIsNotNone(rsync, "no rsync on PATH")
        version = subprocess.run([rsync, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
        with tempfile.TemporaryDirectory() as temporary:
            source, box = Path(temporary, "mac"), Path(temporary, "box")
            write(source / f"sessions/{MOVED}.jsonl", "mac transcript\n")
            write(source / f"session-artifacts/{MOVED}/sub-a/job.jsonl", "mac job\n")
            write(box / f"session-artifacts/{MOVED}/sub-a/job.jsonl", "old pre-copy\n")
            kept = {}
            for chat in SIBLINGS:
                kept[box / f"sessions/{chat}.jsonl"] = f"{chat} box transcript, newer than any Mac copy\n"
                kept[box / f"session-artifacts/{chat}/sub-job/recovered/runtime.patch"] = f"{chat} box-owned work\n"
                kept[box / f"session-artifacts/{chat}/kernel-state.json"] = "{}\n"
            for path, text in kept.items():
                write(path, text)
            result = subprocess.run([rsync, "-aR", "--delete", f"sessions/{MOVED}.jsonl", f"session-artifacts/{MOVED}/", f"{box}/"],
                                    cwd=source, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            gone = [str(path.relative_to(box)) for path, text in kept.items() if not path.exists() or path.read_text() != text]
            self.assertEqual(gone, [], f"{rsync} ({version}) removed or changed sibling chats' files")
            self.assertEqual((box / f"session-artifacts/{MOVED}/sub-a/job.jsonl").read_text(), "mac job\n")


if __name__ == "__main__":
    unittest.main()

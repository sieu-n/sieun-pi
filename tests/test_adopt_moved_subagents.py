"""A chat tree copied to another box brings its subagents' files but no spawn-ledger edges, so on 10-18 us-metal02's daemon answered
"Unknown active session" for 94 children of moved chats. adopt-moved-subagents.py appends the missing edges: parents before children, a
name the parent already gave a fresh copy gets " before move", deleted children and their subtrees stay out, and a second run adds nothing.
Run: python3 -B -m unittest tests/test_adopt_moved_subagents.py"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / "components" / "prime-relay" / "adopt-moved-subagents.py"
spec = importlib.util.spec_from_file_location("adopt", SCRIPT)
adopt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adopt)

ROOT = "01a115e2-9544-7204-b8db-8ce4d5319048"


def child(agent, rel, sid, name, status="completed"):
    folder = agent / "session-artifacts" / ROOT / rel
    folder.mkdir(parents=True)
    (folder / f"{sid}.jsonl").write_text(json.dumps({"type": "session", "id": sid}) + "\n")
    meta = {"type": "rlm_subagent", "childId": rel.split("/")[-1], "sessionName": name, "status": status,
            "sessionFile": f"/Users/someone/.prime/agent/session-artifacts/{ROOT}/{rel}/{sid}.jsonl"}
    (folder / "rlm-subagent.json").write_text(json.dumps(meta))
    return folder / f"{sid}.jsonl"


class AdoptMovedSubagents(unittest.TestCase):
    def test_moved_children_get_edges_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(os.path.realpath(tmp))
            (agent / "sessions").mkdir()
            root = agent / "sessions" / f"{ROOT}.jsonl"
            root.write_text(json.dumps({"type": "session", "id": ROOT}) + "\n")
            fresh = child(agent, "sub-new00001", "01a14d80-0000-7000-8000-000000000001", "census writer speed")
            old = child(agent, "sub-old00001", "01a14ceb-1e15-745d-a4cd-3f29b6766d94", "census writer speed", "running")
            grandchild = child(agent, "sub-old00001/sub-gc000001", "01a14cec-0000-7000-8000-000000000002", "sampler")
            child(agent, "sub-del00001", "01a14c00-0000-7000-8000-000000000003", "gone", "deleted")
            child(agent, "sub-del00001/sub-dc000001", "01a14c01-0000-7000-8000-000000000004", "under gone")
            ledger = Path(adopt.ledger_path(str(agent)))
            ledger.parent.mkdir()
            ledger.write_text(json.dumps({"v": 1, "op": "spawn", "at": "2026-10-18T05:00:00.000Z", "childId": "sub-new00001",
                                          "parent": str(root), "child": str(fresh), "depth": 1, "name": "census writer speed"}) + "\n")
            run = lambda *a: subprocess.run([sys.executable, "-B", str(SCRIPT), *a], env={**os.environ, "PRIME_AGENT_DIR": str(agent)},
                                            capture_output=True, text=True, check=True)
            run("--apply")
            spawns = [json.loads(l) for l in ledger.read_text().splitlines()][1:]
            self.assertEqual([(e["childId"], e["depth"], e["name"], e["parent"]) for e in spawns], [
                ("sub-old00001", 1, "census writer speed before move", str(root)),
                ("sub-gc000001", 2, "sampler", str(old)),
            ])
            self.assertEqual(spawns[1]["child"], str(grandchild))
            self.assertIn("would append 0 edges", run().stderr)


if __name__ == "__main__":
    unittest.main()

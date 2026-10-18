import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
SYNC = REPO / "components/prime-sync/sync.py"
ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


def entry(entry_id, content, updated="2026-10-18T00:00:00+00:00", kind="memory"):
    return {"id": entry_id, "kind": kind, "title": entry_id, "content": content, "path": "general", "scope": "global",
            "reference": {}, "arguments": {}, "metadata": {}, "source": "agent",
            "created_at": "2026-10-01T00:00:00+00:00", "updated_at": updated, "version": 1}


def correction(number, rule):
    return {"id": f"c{number}", "at": f"2026-10-{number:02d}T00:00:00.000Z", "chat": {"id": "x", "name": "x"}, "words": rule,
            "rule": rule, "enforcedBy": "brief", "ref": "", "status": "active", "theme": [], "repeats": []}


class PrimeSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        git("init", "-q", "--bare", "-b", "main", str(self.root / "state.git"))
        git("init", "-q", "--bare", "-b", "main", str(self.root / "code.git"))
        seed = self.root / "seed"
        git("clone", "-q", str(self.root / "code.git"), str(seed))
        (seed / "skills/unslop").mkdir(parents=True)
        (seed / "skills/unslop/SKILL.md").write_text("v1\n")
        (seed / "config").mkdir()
        (seed / "config/AGENTS.md").write_text("rules\n")
        (seed / "config/settings.shared.json").write_text(json.dumps({"defaultThinkingLevel": "high"}))
        (seed / "install-manifest.json").write_text(json.dumps({"version": 1, "entries": [
            {"id": "skill:unslop", "kind": "link", "source": "skills/unslop", "scope": "home", "target": ".prime/agent/skills/unslop"},
            {"id": "agent-rules", "kind": "link", "source": "config/AGENTS.md", "scope": "home", "target": ".prime/agent/AGENTS.md"}]}))
        self.commit(seed, "seed")
        self.seed = seed

    def commit(self, checkout, message):
        git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "add", "-A")
        git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "commit", "-q", "-m", message)
        git("-C", str(checkout), "push", "-q", "origin", "main")

    def box(self, name, memories, corrections):
        home = self.root / name
        agent = home / ".prime/agent"
        (agent / "harness").mkdir(parents=True)
        (agent / "browser-chat").mkdir()
        (agent / "skills/unslop").mkdir(parents=True)
        (agent / "skills/unslop/SKILL.md").write_text("stale copy\n")
        self.write_harness(home, memories)
        (agent / "browser-chat/corrections.json").write_text(json.dumps({"corrections": corrections}))
        git("clone", "-q", str(self.root / "code.git"), str(home / "src/sieun-pi"))
        git("clone", "-q", str(self.root / "state.git"), str(home / "state"))
        (home / ".config/prime-sync").mkdir(parents=True)
        (home / ".config/prime-sync/sync.json").write_text(json.dumps({
            "host": name, "checkout": str(home / "src/sieun-pi"), "stateDir": str(home / "state"), "agentDir": str(agent)}))
        return home

    def write_harness(self, home, memories, refinements=()):
        state = {"schema": 1, "entries": {"prompt": {}, "memory": {m["id"]: m for m in memories}, "skill": {}, "subagent": {}},
                 "refinements": list(refinements)}
        (home / ".prime/agent/harness/harness_state.json").write_text(json.dumps(state, indent=2))

    def memories(self, home):
        return json.loads((home / ".prime/agent/harness/harness_state.json").read_text())["entries"]["memory"]

    def ledger(self, home):
        return [c["id"] for c in json.loads((home / ".prime/agent/browser-chat/corrections.json").read_text())["corrections"]]

    def sync(self, home):
        env = {**ENV, "HOME": str(home), "PRIME_SYNC_SETTLE": "0"}
        result = subprocess.run(["python3", "-B", str(SYNC)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_two_boxes_converge_and_edits_and_deletes_travel(self):
        mac = self.box("mac", [entry("a", "mac a"), entry("b", "b")], [correction(1, "one"), correction(2, "two")])
        box = self.box("box", [entry("a", "old a", "2026-09-01T00:00:00+00:00"), entry("boxonly", "box fact")], [correction(1, "one")])
        self.sync(mac)
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "b", "boxonly"])
        self.assertEqual(self.memories(box)["a"]["content"], "mac a")
        self.assertEqual(self.ledger(box), ["c1", "c2"])
        self.sync(mac)
        self.assertEqual(sorted(self.memories(mac)), ["a", "b", "boxonly"])

        memories = self.memories(mac)
        memories["a"] = entry("a", "mac a v2", "2026-10-18T01:00:00+00:00")
        del memories["b"]
        self.write_harness(mac, memories.values())
        ledger = json.loads((mac / ".prime/agent/browser-chat/corrections.json").read_text())
        ledger["corrections"].append(correction(3, "three"))
        (mac / ".prime/agent/browser-chat/corrections.json").write_text(json.dumps(ledger))
        self.sync(mac)
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "boxonly"])
        self.assertEqual(self.memories(box)["a"]["content"], "mac a v2")
        self.assertEqual(self.ledger(box), ["c1", "c2", "c3"])

    def test_a_clash_goes_to_the_newer_entry(self):
        mac = self.box("mac", [entry("a", "base")], [])
        box = self.box("box", [], [])
        self.sync(mac)
        self.sync(box)
        self.write_harness(mac, [entry("a", "mac edit", "2026-10-18T02:00:00+00:00")])
        self.write_harness(box, [entry("a", "box edit", "2026-10-18T03:00:00+00:00")])
        self.sync(mac)
        self.sync(box)
        self.sync(mac)
        self.assertEqual(self.memories(mac)["a"]["content"], "box edit")
        self.assertEqual(self.memories(box)["a"]["content"], "box edit")

    def test_links_replace_copies_and_follow_main(self):
        box = self.box("box", [], [])
        report = self.sync(box)
        skill = box / ".prime/agent/skills/unslop"
        self.assertTrue(skill.is_symlink())
        self.assertEqual((skill / "SKILL.md").read_text(), "v1\n")
        self.assertEqual(os.readlink(box / ".prime/agent/AGENTS.md"), str(box / "src/sieun-pi/config/AGENTS.md"))
        self.assertIn("set defaultThinkingLevel", report["settings"])
        (self.seed / "skills/unslop/SKILL.md").write_text("v2\n")
        self.commit(self.seed, "edit")
        self.assertIn("pulled", self.sync(box)["code"])
        self.assertEqual((skill / "SKILL.md").read_text(), "v2\n")

    def test_an_emptied_file_never_deletes_the_shared_entries(self):
        mac = self.box("mac", [entry("a", "a"), entry("b", "b")], [])
        self.sync(mac)
        self.write_harness(mac, [])
        self.assertIn("skipped", self.sync(mac)["state"])
        box = self.box("box", [], [])
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "b"])


if __name__ == "__main__":
    unittest.main()

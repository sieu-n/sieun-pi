"""scripts/skills-inventory.py on a throwaway home: which harness entries become copies.

    python3 -B -m unittest tests/test_skills_inventory.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCANNER = Path(__file__).resolve().parent.parent / "scripts/skills-inventory.py"


def store(path: Path, entries: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "entries": entries}))


def entry(title: str) -> dict:
    return {"title": title, "content": f"{title}.", "updated_at": "2026-11-25T00:00:00Z", "source": "refine", "version": 1}


class HarnessCopies(unittest.TestCase):
    def test_agent_store_skills_and_subagents_are_copies_that_name_the_agent(self):
        with tempfile.TemporaryDirectory() as home:
            store(Path(home, ".prime/agent/harness/harness_state.json"), {"skill": {"release_notes": entry("Global release notes")}, "memory": {"a_rule": entry("A rule")}})
            store(Path(home, ".pi/agent/agents/tester/harness/harness_state.json"), {
                "skill": {"release_notes": entry("Tester release notes")},
                "subagent": {"pr_reviewer": entry("Reviews a PR")},
                "memory": {"a_fact": entry("A fact")},
                "prompt": {"a_note": entry("A note")},
            })
            out = Path(home, "inventory.json")
            subprocess.run([sys.executable, "-B", str(SCANNER), "--no-mac", "--no-usage", "--out", str(out)], env={**os.environ, "HOME": home},
                           check=True, capture_output=True)
            copies = json.loads(out.read_text())["copies"]
            harness = sorted((c["path"], c["source"], c["name"], c["how"]) for c in copies if c["path"].startswith("harness:"))
            self.assertEqual(harness, [
                ("harness:skill:release_notes", "harness-skill", "release_notes", "Prime continual harness (global)"),
                ("harness:skill:tester/release_notes", "harness-skill", "release_notes", "pi-host agent memory (tester)"),
                ("harness:subagent:tester/pr_reviewer", "harness-subagent", "pr_reviewer", "pi-host agent memory (tester)"),
            ])


if __name__ == "__main__":
    unittest.main()

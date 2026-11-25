"""scripts/skills_usage.py: which skill and SKILL.md path a read-skill.mjs read counts for.

    python3 -B -m unittest tests/test_skills_usage.py
"""

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("skills_usage", Path(__file__).resolve().parent.parent / "scripts/skills_usage.py")
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)

READ = usage.HOW_READ


def reads(command):
    matcher = usage.Matcher({"board": "board"}, {"board": "board"})
    return sorted(matcher.call("bash", {"command": command}))


class ReadSkillReads(unittest.TestCase):
    def test_a_reference_file_counts_for_its_skill(self):
        found = reads("node /r/auto-sns-agent/scripts/skills/read-skill.mjs apps/llm-wiki/references/writing.md")
        self.assertEqual([use for use in found if "|" in use[1]], [("llm-wiki", f"{READ}|/r/auto-sns-agent/.agents/skills/apps/llm-wiki/SKILL.md")])

    def test_a_flag_or_a_redirect_is_no_skill(self):
        self.assertEqual(reads("node scripts/skills/read-skill.mjs --help"), [])
        self.assertEqual(reads("node scripts/skills/read-skill.mjs 2>&1 | head"), [])
        self.assertEqual(reads("cat /r/auto-sns-agent/scripts/skills/read-skill.mjs 2>/dev/null | head -80"), [])

    def test_an_argument_that_repeats_the_skills_root_names_the_folder_once(self):
        self.assertIn(("verify", f"{READ}|/r/a/.agents/skills/repo/verify/SKILL.md"), reads("node /r/a/scripts/skills/read-skill.mjs .agents/skills/repo/verify"))
        self.assertIn(("verify", f"{READ}|/r/b/.agents/skills/repo/verify/SKILL.md"), reads("node /r/a/scripts/skills/read-skill.mjs /r/b/.agents/skills/repo/verify/SKILL.md"))
        self.assertIn(("verify", f"{READ}|.agents/skills/repo/verify/SKILL.md"), reads("node scripts/skills/read-skill.mjs @code/.agents/skills/repo/verify/SKILL.md"))

    def test_a_relative_script_is_read_under_the_last_cd(self):
        self.assertIn(("verify", f"{READ}|~/Documents/Github/auto-sns-agent/.agents/skills/repo/verify/SKILL.md"),
                      reads("cd /tmp && cd ~/Documents/Github/auto-sns-agent && node scripts/skills/read-skill.mjs repo/verify"))
        self.assertIn(("verify", f"{READ}|.agents/skills/repo/verify/SKILL.md"), reads("node scripts/skills/read-skill.mjs repo/verify"))


if __name__ == "__main__":
    unittest.main()

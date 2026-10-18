import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.check_skills import check_skills, main, skill_name


REPO = Path(__file__).resolve().parents[1]
VALID_SKILL = "---\nname: example\ndescription: Test source checks.\n---\n# Example\n"


class SkillSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.write("example/SKILL.md", VALID_SKILL)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_source_check_does_not_execute_scripts_or_write_bytecode(self):
        self.write("example/operation.py", "raise RuntimeError('never execute this')\n")
        self.write("example/package.json", '{"name": "example"}')
        self.write("example/pyproject.toml", '[project]\nname = "example"\n')
        self.write("example/uv.lock", "version = 1\n")
        self.write("helpers/__init__.py", "")
        before = sorted(path.relative_to(self.root) for path in self.root.rglob("*"))
        report = check_skills(self.root)
        self.assertEqual(report.errors, ())
        self.assertEqual(report.counts, {
            "skills": 1, "helper_packages": 1, "source_files": 6,
            "python_files": 2, "json_files": 1, "toml_files": 2, "yaml_files": 0,
        })
        self.assertEqual(before, sorted(path.relative_to(self.root) for path in self.root.rglob("*")))

    def test_python_compile_rejects_invalid_statements(self):
        self.write("example/broken.py", "return 1\n")
        report = check_skills(self.root)
        self.assertEqual(len(report.errors), 1)
        self.assertIn("broken.py", report.errors[0])
        self.assertIn("outside function", report.errors[0])

    def test_metadata_errors_are_reported_together(self):
        self.write("example/package.json", "{")
        self.write("example/pyproject.toml", "[project")
        self.write("example/data.yaml", "key: [")
        report = check_skills(self.root)
        self.assertEqual(len(report.errors), 3)
        for filename in ("package.json", "pyproject.toml", "data.yaml"):
            self.assertTrue(any(filename in error for error in report.errors))

    def test_frontmatter_validation(self):
        invalid = [
            "# Missing",
            "---\nname: example",
            "---\n- example\n---\nBody",
            "---\nnull\n---\nBody",
            VALID_SKILL.replace("name: example", "name: Other"),
            VALID_SKILL.replace("name: example", "name: other"),
            VALID_SKILL.replace("name: example", "name: example\nname: example"),
            VALID_SKILL.replace("description: Test source checks.", "description: []"),
            VALID_SKILL.replace("Test source checks.", "x" * 1025),
            VALID_SKILL.replace("description: Test source checks.", "description: broken: yaml"),
            VALID_SKILL.replace("description: Test source checks.", 'description: ""'),
            VALID_SKILL.replace("# Example", ""),
            VALID_SKILL.replace("name: example", 'name: example\ndisable-model-invocation: "false"'),
            VALID_SKILL.replace("name: example", "name: example\nmetadata: []"),
            VALID_SKILL.replace("name: example", "name: example\ntrue: unexpected"),
            VALID_SKILL.replace("name: example", "name: !!python/object:builtins.str example"),
        ]
        path = self.root / "example/SKILL.md"
        for text in invalid:
            with self.subTest(text=text):
                path.write_text(text, encoding="utf-8")
                self.assertTrue(check_skills(self.root).errors)

    def test_crlf_frontmatter_and_optional_metadata(self):
        text = VALID_SKILL.replace(
            "name: example", "name: example\ndisable-model-invocation: false\nmetadata:\n  icon: crown"
        ).replace("\n", "\r\n")
        self.assertEqual(skill_name(self.root / "example/SKILL.md", text), "example")

    def test_ignored_generated_files(self):
        for folder in (".venv", "node_modules", "dist", "build", "__pycache__", ".cache"):
            self.write(f"example/{folder}/broken.py", "return 1")
            self.write(f"{folder}/broken.py", "return 1")
        self.write("example/stale.pyc", "not Python source")
        report = check_skills(self.root)
        self.assertEqual(report.errors, ())
        self.assertEqual(report.counts["source_files"], 1)

    def test_missing_skill_file_and_empty_tree_fail(self):
        (self.root / "example/SKILL.md").unlink()
        report = check_skills(self.root)
        self.assertIn("no SKILL.md files found", report.errors)
        self.assertTrue(any("missing SKILL.md" in error for error in report.errors))
        self.assertTrue(check_skills(self.root / "missing").errors)

    def test_duplicate_names_in_nested_roots_fail(self):
        self.write("example/nested/example/SKILL.md", VALID_SKILL)
        self.assertTrue(any("duplicate skill name" in error for error in check_skills(self.root).errors))

    def test_symlink_sources_fail_without_reading_target(self):
        (self.root / "example/unsafe.py").symlink_to(self.root / "absent.py")
        (self.root / "example/unsafe-dir").symlink_to(self.root, target_is_directory=True)
        report = check_skills(self.root)
        self.assertEqual(len(report.errors), 2)
        self.assertTrue(all("symlink" in error for error in report.errors))

    def test_cli_reports_counts_and_failure_status(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["--skills-dir", str(self.root)]), 0)
        self.assertIn("1 skills", output.getvalue())
        self.assertIn("No skill operations executed", output.getvalue())
        self.write("example/broken.py", "return 1")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--skills-dir", str(self.root)]), 1)

    def test_repository_skill_sources(self):
        report = check_skills(REPO / "skills")
        self.assertEqual(report.errors, ())
        self.assertGreater(report.counts["skills"], 0)
        self.assertGreater(report.counts["python_files"], 0)


class SkillPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.profile = self.root / "profile"
        self.enterContext(patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": str(self.profile)}))
        self.skills = self.root / "skills"
        example = self.skills / "example/SKILL.md"
        example.parent.mkdir(parents=True)
        example.write_text(VALID_SKILL.replace("name: example", "name: example\ndisable-model-invocation: true"))

    def script(self, filename):
        spec = importlib.util.spec_from_file_location(
            filename.replace("-", "_"), REPO / "skills/setup-pstack/scripts" / filename
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_model_invocation_writer_uses_only_explicit_paths(self):
        script = self.script("toggle-model-invocation.py")
        defaults = self.root / "state/defaults.json"
        args = ["--skills-dir", str(self.skills), "--defaults-file", str(defaults)]
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(script.main(args + ["--show"]), 0)
        self.assertEqual(before, {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(script.main(args + ["--expose"]), 0)
            self.assertFalse(script.state(self.skills)["example"])
            saved = defaults.read_bytes()
            self.assertEqual(script.main(args + ["--expose"]), 0)
            self.assertEqual(defaults.read_bytes(), saved)
            self.assertEqual(script.main(args + ["--hide"]), 0)
        self.assertTrue(script.state(self.skills)["example"])

    def test_defaults_stay_in_active_profile_with_symlinked_skills(self):
        self.profile.mkdir()
        linked_skills = self.profile / "skills"
        linked_skills.symlink_to(self.skills, target_is_directory=True)
        script = self.script("toggle-model-invocation.py")
        args = ["--skills-dir", str(linked_skills)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(script.main(args + ["--expose"]), 0)
            self.assertFalse(script.state(self.skills)["example"])
            self.assertEqual(script.main(args + ["--hide"]), 0)
        self.assertTrue(script.state(self.skills)["example"])
        self.assertTrue((self.profile / "state/setup-pstack/model-invocation-defaults.json").is_file())
        self.assertEqual([path.relative_to(self.skills) for path in self.skills.rglob("*") if path.is_file()], [Path("example/SKILL.md")])

    def test_frontmatter_script_uses_explicit_checkout_and_rejects_empty_input(self):
        script = self.script("validate-frontmatter.py")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(script.main(["--skills-dir", str(self.skills)]), 0)
            (self.skills / "example/SKILL.md").write_text("---\n- invalid\n---\nBody\n")
            self.assertEqual(script.main(["--skills-dir", str(self.skills)]), 1)
            self.assertEqual(script.main(["--skills-dir", str(self.root / "missing")]), 1)


if __name__ == "__main__":
    unittest.main()

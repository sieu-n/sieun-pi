"""Read-only skill source checks. Requires Python 3.11+ and PyYAML.

Run from the checkout with ``uv run python scripts/check_skills.py``.
Package imports, Bun tests, and runtime operations are separate checks.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import tomllib

import yaml


IGNORED_DIRS = frozenset({
    ".git", ".work", ".venv", "venv", "node_modules", "dist", "build",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache",
})
SKILL_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


@dataclass(frozen=True)
class CheckReport:
    counts: dict[str, int]
    errors: tuple[str, ...]


class UniqueKeyLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        mapping = super().construct_mapping(node, deep=deep)
        if len(mapping) != len(node.value):
            raise ValueError("duplicate YAML keys")
        return mapping


def skill_name(path: Path, text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("missing YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("missing closing frontmatter delimiter") from None
    metadata = yaml.load("\n".join(lines[1:end]), Loader=UniqueKeyLoader)
    if not isinstance(metadata, dict):
        raise ValueError("frontmatter must be a mapping")
    if not all(isinstance(key, str) for key in metadata):
        raise ValueError("frontmatter keys must be strings")
    name = metadata.get("name")
    if not isinstance(name, str) or not SKILL_NAME.fullmatch(name) or len(name) > 64:
        raise ValueError("name must be a lowercase hyphenated identifier of at most 64 characters")
    if name != path.parent.name:
        raise ValueError(f"name {name!r} does not match directory {path.parent.name!r}")
    description = metadata.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must be a nonempty string")
    if len(description) > 1024:
        raise ValueError("description exceeds 1024 characters")
    if "disable-model-invocation" in metadata and not isinstance(metadata["disable-model-invocation"], bool):
        raise ValueError("disable-model-invocation must be a boolean")
    if "metadata" in metadata and not isinstance(metadata["metadata"], dict):
        raise ValueError("metadata must be a mapping")
    if not any(line.strip() for line in lines[end + 1:]):
        raise ValueError("skill body is empty")
    return name


def check_skills(root: Path) -> CheckReport:
    counts = Counter({
        "skills": 0, "helper_packages": 0, "source_files": 0,
        "python_files": 0, "json_files": 0, "toml_files": 0, "yaml_files": 0,
    })
    errors: list[str] = []
    names: dict[str, Path] = {}
    if not root.is_dir():
        return CheckReport(dict(counts), (f"{root}: skills directory does not exist",))

    for directory, children, files in os.walk(root, followlinks=False, onerror=lambda error: errors.append(str(error))):
        folder = Path(directory)
        children[:] = sorted(name for name in children if name not in IGNORED_DIRS and not name.endswith(".egg-info"))
        for name in children[:]:
            child = folder / name
            if child.is_symlink():
                errors.append(f"{child.relative_to(root)}: source symlinks are not allowed")
                children.remove(name)
            elif folder == root and not (child / "SKILL.md").is_file():
                if (child / "__init__.py").is_file():
                    counts["helper_packages"] += 1
                else:
                    errors.append(f"{name}: missing SKILL.md or Python package __init__.py")
        for filename in sorted(files):
            if filename.endswith((".pyc", ".pyo")) or filename == ".DS_Store":
                continue
            path = folder / filename
            relative = path.relative_to(root)
            if path.is_symlink():
                errors.append(f"{relative}: source symlinks are not allowed")
                continue
            counts["source_files"] += 1
            try:
                if filename == "SKILL.md":
                    counts["skills"] += 1
                    name = skill_name(path, path.read_text(encoding="utf-8"))
                    if name in names:
                        raise ValueError(f"duplicate skill name {name!r}, first found at {names[name]}")
                    names[name] = relative
                elif path.suffix == ".py":
                    counts["python_files"] += 1
                    compile(path.read_bytes(), str(path), "exec", dont_inherit=True)
                elif path.suffix == ".json":
                    counts["json_files"] += 1
                    json.loads(path.read_text(encoding="utf-8"))
                elif path.suffix == ".toml" or filename == "uv.lock":
                    counts["toml_files"] += 1
                    tomllib.loads(path.read_text(encoding="utf-8"))
                elif path.suffix in {".yaml", ".yml"}:
                    counts["yaml_files"] += 1
                    yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
            except (OSError, UnicodeError, ValueError, SyntaxError, yaml.YAMLError) as error:
                errors.append(f"{relative}: {error}")
    if counts["skills"] == 0:
        errors.append("no SKILL.md files found")
    return CheckReport(dict(counts), tuple(errors))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills-dir", type=Path, default=Path(__file__).resolve().parents[1] / "skills")
    args = parser.parse_args(argv)
    report = check_skills(args.skills_dir)
    print("Checked " + ", ".join(f"{count} {name}" for name, count in report.counts.items()))
    for error in report.errors:
        print(f"ERROR {error}")
    print(f"{len(report.errors)} errors. No skill operations executed.")
    return int(bool(report.errors))


if __name__ == "__main__":
    raise SystemExit(main())

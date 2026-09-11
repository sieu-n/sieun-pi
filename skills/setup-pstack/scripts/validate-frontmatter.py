#!/usr/bin/env python3
"""Check SKILL.md frontmatter. Requires PyYAML.

The default is the active Prime Agent profile. Use --skills-dir for a checkout.
"""
import argparse
import os
import pathlib
import re
import sys

import yaml


def main(argv=None):
    agent_dir = pathlib.Path(
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or pathlib.Path.home() / ".prime/agent"
    ).expanduser()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills-dir", type=pathlib.Path, default=agent_dir / "skills")
    args = parser.parse_args(argv)
    files = sorted(args.skills_dir.glob("*/SKILL.md"))
    bad = []
    for path in files:
        match = re.match(r"^---\n(.*?)\n---\n", path.read_text(), re.S)
        if not match:
            bad.append((path, "no frontmatter"))
            continue
        try:
            metadata = yaml.safe_load(match.group(1))
        except yaml.YAMLError as error:
            bad.append((path, f"YAML: {str(error).splitlines()[0]}"))
            continue
        if not isinstance(metadata, dict):
            bad.append((path, "frontmatter must be a mapping"))
        elif not isinstance(metadata.get("name"), str) or not metadata["name"].strip():
            bad.append((path, "missing name"))
        elif not isinstance(metadata.get("description"), str) or not metadata["description"].strip():
            bad.append((path, "missing description"))
    print(f"checked {len(files)} skills, {len(bad)} broken")
    for path, why in bad:
        print(f"  BROKEN {path.parent.name}: {why}")
    if not files:
        print(f"no skills found at {args.skills_dir}", file=sys.stderr)
    return int(bool(bad) or not files)


if __name__ == "__main__":
    raise SystemExit(main())

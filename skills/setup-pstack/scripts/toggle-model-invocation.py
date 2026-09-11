#!/usr/bin/env python3
"""Show or flip `disable-model-invocation` on the installed pstack skills.

Prime
Agent honours that flag: those skills still load, but they are left out of the
`<available_skills>` block in the system prompt, so the model never routes to
them on its own. They stay reachable with `/skill:<name>`.

Usage:
  python3 toggle-model-invocation.py            # report current state
  python3 toggle-model-invocation.py --show     # same
  python3 toggle-model-invocation.py --expose   # make every pstack skill model-invocable
  python3 toggle-model-invocation.py --hide     # restore the pstack defaults
"""
import argparse
import json
import os
import pathlib
import re
import sys

AGENT_DIR = pathlib.Path(
    os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
    or os.environ.get("PI_CODING_AGENT_DIR")
    or pathlib.Path.home() / ".prime/agent"
).expanduser()
SKILLS = AGENT_DIR / "skills"
FLAG = re.compile(r"^disable-model-invocation:.*$\n?", re.M)


def frontmatter(path):
    text = path.read_text()
    m = re.match(r"^---\n(.*?\n)---\n", text, re.S)
    return (m.group(1), text[m.end():]) if m else (None, text)


def state(skills=SKILLS):
    out = {}
    for d in sorted(p for p in skills.iterdir() if p.is_dir()):
        f = d / "SKILL.md"
        if not f.exists():
            continue
        fm, _ = frontmatter(f)
        out[d.name] = bool(fm and re.search(r"^disable-model-invocation:\s*true", fm, re.M))
    return out


def write_flag(path, hidden):
    fm, body = frontmatter(path)
    if fm is None:
        return False
    new = FLAG.sub("", fm)
    if hidden:
        new = new.rstrip("\n") + "\ndisable-model-invocation: true\n"
    if new == fm:
        return False
    path.write_text("---\n" + new + "---\n" + body)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--expose", action="store_true")
    mode.add_argument("--hide", action="store_true")
    mode.add_argument("--show", action="store_true")
    ap.add_argument("--skills-dir", type=pathlib.Path, default=SKILLS)
    ap.add_argument("--defaults-file", type=pathlib.Path)
    args = ap.parse_args(argv)
    defaults = args.defaults_file or AGENT_DIR / "state/setup-pstack/model-invocation-defaults.json"

    cur = state(args.skills_dir)
    if not (args.expose or args.hide):
        hidden = [k for k, v in cur.items() if v]
        print(f"{len(cur)} skills; {len(hidden)} hidden from the system prompt")
        for k in hidden:
            print("  hidden:", k)
        return 0

    if args.expose:
        if not defaults.exists():
            defaults.parent.mkdir(parents=True, exist_ok=True)
            defaults.write_text(json.dumps(cur, indent=2))
        changed = [k for k, v in cur.items() if v and write_flag(args.skills_dir / k / "SKILL.md", False)]
        print(f"exposed {len(changed)} skills; defaults saved to {defaults}")
    else:
        if not defaults.exists():
            print("no saved defaults; nothing to restore", file=sys.stderr)
            return 1
        saved = json.loads(defaults.read_text())
        changed = [k for k, v in saved.items() if v and write_flag(args.skills_dir / k / "SKILL.md", True)]
        print(f"re-hid {len(changed)} skills")
    print("run `node <prime-agent>/dist/core/skills.js` consumers or restart a session to pick it up")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

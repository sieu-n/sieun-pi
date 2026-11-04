"""Refuses a Python walk of all of home or the wiki content root from a kernel cell (global AGENTS.md rule 6, the owner's rule).

On 11-04 two wiki jobs ran `glob.glob(root + "**/*.html", recursive=True)` over the whole content root, about 100 GB with sessions/, for 56
and 24 min in one tool call each, after rule 6 had been written down (c81). walk.ts judges find, rg and grep -r; this file judges the
Python walks a cell makes as they run, because a cell builds the root at run time.

1. glob.glob and glob.iglob with recursive=True and a `**` part, Path.glob with a `**` part and Path.rglob raise WalkRefused when the
   folder they start from is home, the wiki content root, or a folder that holds one of them.
2. os.walk and os.fwalk of such a folder yield its top level, so `next(os.walk(root))` lists it. They raise WalkRefused when the walk would
   go deeper, unless the root is the wiki content root and the caller pruned `dirs` to curated folders (apps, domains, projects,
   experiments). A bottom-up walk of such a folder raises at once.
3. Only a call made by cell code (a frame whose file is "<cell-N>", which covers helpers a cell defines) is judged, so library and
   skill code runs as before.

Hard limit: owner rule 6 says never, and c81's measured repeats show the text did not hold (on 11-04 walks of 56 and 24 min), while a warning would come only after the walk.
The prelude in kernel-guard.ts runs this file once per kernel.
"""

import glob
import json
import os
import pathlib
import re
import sys

CELL = re.compile(r"<cell-\d+>\Z")
OWN_MODULES = frozenset({"global_rules_kernel_walk", "glob", "os", "pathlib", "posixpath", "ntpath"})
CURATED = frozenset({"apps", "domains", "projects", "experiments"})
TAIL = (
    "Owner rule 6: never walk all of home or the wiki content root, which holds about 100 GB of sessions/ and agents/; on 11-04 two wiki "
    "jobs' recursive globs of it held a pool slot and a CPU for 56 and 24 min. Walk only the folder you need. For wiki pages, ask the wiki "
    "API: `httpx.get(wiki.base_url() + '/wiki/api/agent/find', params={'glob': 'apps/**'}).json()['results']` lists the pages of one "
    "curated folder, and `/wiki/api/agent/grep` with `params={'pattern': 'mermaid', 'glob': 'apps/**', 'context': 0}` returns one row per "
    "matching line with its `path`; run each for apps/**, domains/**, projects/** and experiments/**. On disk on us-metal02, walk one "
    "curated folder at a time, such as `glob.glob(os.path.expanduser('~/.pi/wiki/content/apps/**/*.html'), recursive=True)` or `rg -l "
    "mermaid ~/.pi/wiki/content/apps ~/.pi/wiki/content/domains ~/.pi/wiki/content/projects ~/.pi/wiki/content/experiments`. For home, "
    "name the folder you mean, such as `rg -l x ~/src/sieun-pi` or `find ~/.config -name auth.json`, or list it with `find ~ -maxdepth 3`."
)


# Hard limit: owner rule 6 says never, and c81's measured repeats show the text did not hold (on 11-04 walks of 56 and 24 min).
class WalkRefused(Exception):
    """A walk of all of home or the wiki content root."""


def content_root(home: str) -> str:
    """The wiki content root that ~/.config/sieun-pi/wiki.json names, else ~/.pi/wiki/content."""
    try:
        with open(os.path.join(home, ".config", "sieun-pi", "wiki.json"), encoding="utf-8") as handle:
            root = json.load(handle).get("contentRoot")
        if isinstance(root, str) and root:
            return os.path.realpath(os.path.expanduser(root))
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.realpath(os.path.join(home, ".pi", "wiki", "content"))


def holds(outer: str, inner: str) -> bool:
    return inner == outer or inner.startswith(outer.rstrip(os.sep) + os.sep)


def walk_root(path) -> "tuple[str, bool] | None":
    """What a walk from `path` would cover whole, and whether `path` is the wiki content root itself; None for any other folder."""
    home = os.path.realpath(os.path.expanduser("~"))
    content = content_root(home)
    at = os.path.realpath(os.path.expanduser(os.fsdecode(path)))
    if at == content:
        return f"wiki content root {content}", True
    if holds(at, home):
        return f"home {home}", False
    if holds(at, content):
        return f"folder {at}, which holds the wiki content root {content}", False
    return None


def from_cell() -> bool:
    """Whether the code that called the walk is cell code: the first frame outside this file and the stdlib walk modules."""
    frame = sys._getframe(1)
    while frame is not None and frame.f_globals.get("__name__") in OWN_MODULES:
        frame = frame.f_back
    return frame is not None and CELL.match(frame.f_code.co_filename) is not None


def refuse(call: str, what: str) -> WalkRefused:
    return WalkRefused(f"global-rules wiki walk guard: `{call}` walks the whole {what}. {TAIL}")


def literal_head(pattern: str) -> "tuple[str, bool]":
    """The folder part of a glob pattern before its first wildcard, and whether a later part is `**`."""
    parts = pattern.split(os.sep)
    head = []
    for part in parts:
        if glob.has_magic(part):
            break
        head.append(part)
    rest = parts[len(head):]
    return os.sep.join(head) or (os.sep if pattern.startswith(os.sep) else ""), "**" in rest


def check_glob(name: str, pattern, root_dir=None) -> None:
    text = os.fsdecode(pattern)
    head, recursive = literal_head(text)
    if not recursive:
        return
    base = os.path.join(os.fsdecode(root_dir) if root_dir is not None else os.getcwd(), head)
    hit = walk_root(base)
    if hit and from_cell():
        raise refuse(f"{name}({text!r}, recursive=True)", hit[0])


def guarded_glob(original, name: str):
    def wrapped(pathname, *args, **kwargs):
        if kwargs.get("recursive"):
            check_glob(name, pathname, kwargs.get("root_dir"))
        return original(pathname, *args, **kwargs)

    wrapped.walk_guarded = True
    wrapped.__doc__ = original.__doc__
    return wrapped


def guarded_path_glob(original, recursive_always: bool):
    def wrapped(self, pattern, *args, **kwargs):
        text = os.fsdecode(pattern)
        head, recursive = literal_head(text)
        if recursive or recursive_always:
            hit = walk_root(self if recursive_always else os.path.join(os.fspath(self), head))
            if hit and from_cell():
                raise refuse(f"Path({os.fspath(self)!r}).{'rglob' if recursive_always else 'glob'}({text!r})", hit[0])
        return original(self, pattern, *args, **kwargs)

    wrapped.walk_guarded = True
    wrapped.__doc__ = original.__doc__
    return wrapped


def pruned(walk, call: str, what: str, exact: bool):
    first = next(walk, None)
    if first is None:
        return
    yield first
    dirs = first[1]
    if dirs and not (exact and set(dirs) <= CURATED):
        walk.close()
        raise refuse(call, f"{what} below its top level")
    yield from walk


def guarded_walk(original, name: str):
    def wrapped(top=".", *args, **kwargs):
        hit = walk_root(top) if from_cell() else None
        if not hit:
            return original(top, *args, **kwargs)
        topdown = kwargs.get("topdown", args[0] if args else True)
        call = f"{name}({os.fsdecode(top)!r})"
        if not topdown:
            raise refuse(call, hit[0])
        return pruned(original(top, *args, **kwargs), call, *hit)

    wrapped.walk_guarded = True
    wrapped.__doc__ = original.__doc__
    return wrapped


def install() -> None:
    for name in ("glob", "iglob"):
        original = getattr(glob, name)
        if not getattr(original, "walk_guarded", False):
            setattr(glob, name, guarded_glob(original, f"glob.{name}"))
    for name, always in (("glob", False), ("rglob", True)):
        original = getattr(pathlib.Path, name)
        if not getattr(original, "walk_guarded", False):
            setattr(pathlib.Path, name, guarded_path_glob(original, always))
    for name in ("walk", "fwalk"):
        original = getattr(os, name, None)
        if original is not None and not getattr(original, "walk_guarded", False):
            setattr(os, name, guarded_walk(original, f"os.{name}"))
    original = getattr(pathlib.Path, "walk", None)
    if original is not None and not getattr(original, "walk_guarded", False):
        def path_walk(self, top_down=True, *args, **kwargs):
            hit = walk_root(self) if from_cell() else None
            if not hit:
                return original(self, top_down, *args, **kwargs)
            call = f"Path({os.fspath(self)!r}).walk()"
            if not top_down:
                raise refuse(call, hit[0])
            return pruned(original(self, top_down, *args, **kwargs), call, *hit)

        path_walk.walk_guarded = True
        pathlib.Path.walk = path_walk


install()

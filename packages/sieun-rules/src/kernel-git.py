"""Puts git-child/git first on the PATH of a Prime kernel on the owner's Mac, so each `git grep` the kernel and its children run skips binary files.

On 2026-11-08 at 15:39:30Z and 15:49:30Z a take-in.mjs git grep of the chat sep launch!! (product guy) held 23.7 and 41.94 GB on the Mac,
and swap went from 18.7 to 20.8 GB. Ad hoc regex greps of the same chat held 1.64 GB on 10-30 and 2.68 GB on 11-03. On 11-09 the cause
measured as Apple Git's regex match of binary files under a UTF-8 locale: any regex git grep over auto-sns-agent's apps/, even
`extract.earerToken`, passed 400 MB within 1 s, one 4.8 MB .otf took 110 MB, and with -I the same greps peaked at 23 to 28 MB.
The same grep took 40 MB on us-metal02, so other hosts keep their PATH. SIEUN_RULES_REAL_GIT names the git the wrapper runs.
"""

import os
import shutil
import sys

GIT_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "git-child")


def install() -> None:
    if sys.platform != "darwin" or not os.path.isfile(os.path.join(GIT_DIR, "git")):
        return
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p and os.path.realpath(p) != GIT_DIR]
    real = os.environ.get("SIEUN_RULES_REAL_GIT") or shutil.which("git", path=os.pathsep.join(parts)) or "/usr/bin/git"
    os.environ["SIEUN_RULES_REAL_GIT"] = real
    os.environ["PATH"] = os.pathsep.join([GIT_DIR, *parts])


install()

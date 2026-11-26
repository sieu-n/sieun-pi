"""stable_path(): a path inside a sieun-pi-runtime or pi-host release, named through that install's `current` link.

A kernel loads its guard files from the release it started in, and every process it starts inherits the release paths those files put in
NODE_OPTIONS, PATH and PYTHONPATH. A release prune deletes the old folder while such processes still run. On the Mac pm2's Vent, started
from a kernel, died at preload with MODULE_NOT_FOUND from 11-21 to 11-26 after its sieun-pi-runtime release was pruned. On 11-26 every
pi-host kernel on the Mac and us-metal02 named pi-host/release-e7e0a88 in NODE_OPTIONS and in the send-check judge it starts, so a prune
of that release would have broken each Node child and turned the send guard off. Both installs swap current by rename, so a path through
current stays valid.
"""

import os


def stable_path(path: str) -> str:
    """<runtime>/sieun-pi-runtime/releases/<sha>/<rest> as <runtime>/sieun-pi-runtime/current/<rest>, and <share>/pi-host/release-<sha>/<rest>
    as <share>/pi-host/current/<rest>, when that file or folder exists under current. Any other path, or one current lacks, stays as it is."""
    parts = path.split(os.sep)
    for i in range(len(parts) - 1):
        if parts[i] == "sieun-pi-runtime" and parts[i + 1] == "releases":
            root, rest = parts[: i + 1], parts[i + 3 :]
        elif parts[i] == "pi-host" and parts[i + 1].startswith("release-"):
            root, rest = parts[: i + 1], parts[i + 2 :]
        else:
            continue
        moved = os.sep.join(root + ["current"] + rest)
        return moved if rest and os.path.exists(moved) else path
    return path

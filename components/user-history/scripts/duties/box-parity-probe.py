"""The Box tools parity duty's probe: one host's side of each tool row in box-parity.rows.json, printed as one JSON object.

The precheck (box-parity.ts) runs this file on the box and, over one `ssh mac`, on the owner's MacBook Pro. On the Mac it only reads: file
and folder presence, hashes, JSON keys, localhost ports, one `launchctl list`, and a CLI version from its install path (Homebrew Cellar,
npm package.json); a CLI whose path carries no version is run with `--version` once and cached by its path and mtime.
On the box it also makes the real calls: logins, kernel imports and MCP initialize plus tools/list. Python 3.9 stdlib, because ssh on the
Mac starts /usr/bin/python3.
Usage: python3 box-parity-probe.py <base64 of {"host": "mac"|"box", "rows": [...], "known": {cli: version read}}>
A value is "ok", "absent", "fail: <why>", "v:<version>", "=<output>", "sha:<hex>", "blobs:<json list>" or "set:<json list>".
"""
import base64, configparser, glob, hashlib, json, os, re, select, socket, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
REPO = HOME + "/Documents/Github/auto-sns-agent"
# One call's limit, the same as CALL_TIMEOUT_MS in skills-and-tools.ts: the slowest call that finished on us-metal02 took 26.4 s at load 420 on
# 80 cores (10-19 at 20:59Z), and at 20:06Z a `cli vercel` call ran past the 25 s limit this replaced. A call that hangs still fails.
TIMEOUT_S = 60
VERSION = re.compile(r"\d+(?:\.\d+)+[a-z]?")
READS = {"const", "path", "which", "glob", "ls", "keys", "sha", "port", "launchd", "version", "distinfo", "gitconfig", "ini", "tip", "blob"}


def nvm_bin():
    """The bin folder of nvm's default node, which a login shell puts on PATH: the newest installed version that matches ~/.nvm/alias/default."""
    try:
        alias = open(HOME + "/.nvm/alias/default").read().strip().lstrip("v")
    except OSError:
        return []
    found = [d for d in glob.glob(HOME + "/.nvm/versions/node/v*/bin") if re.match(r"v" + re.escape(alias) + r"(\.|$)", d.split("/")[-2])]
    numbers = lambda d: [int(n) for n in re.findall(r"\d+", d.split("/")[-2])]
    return sorted(found, key=numbers)[-1:]


def search_path():
    nvm = nvm_bin()
    dirs = [HOME + "/.local/bin", HOME + "/.bun/bin"] + nvm + [HOME + "/.local/share/pnpm", HOME + "/.local/node/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin",
            "/usr/local/bin", HOME + "/.docker/bin", "/usr/bin", "/bin", "/snap/bin", HOME + "/bin", HOME + "/.cargo/bin", HOME + "/go/bin", "/usr/sbin", "/sbin"]
    seen = []
    for d in dirs + os.environ.get("PATH", "").split(":"):
        if d and d not in seen:
            seen.append(d)
    return ":".join(seen)


PATH = search_path()
ENV = dict(os.environ, PATH=PATH, NO_COLOR="1", CI="1")


def expand(text):
    return HOME + text[1:] if text.startswith("~") else text


def which(name):
    if "/" in name:
        path = expand(name)
        return path if os.path.isfile(path) and os.access(path, os.X_OK) else None
    for d in PATH.split(":"):
        path = os.path.join(d, name)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def brief(text, size=160):
    return re.sub(r"\s+", " ", text or "").strip()[:size]


def run(argv, cwd=None):
    cwd = expand(cwd) if cwd else None
    first = os.path.join(cwd, argv[0]) if cwd and "/" in argv[0] else which(argv[0])
    if not first or not os.access(first, os.X_OK):
        return None, "absent"
    try:
        done = subprocess.run([first] + [expand(a) for a in argv[1:]], capture_output=True, text=True, timeout=TIMEOUT_S, env=ENV, cwd=cwd, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "fail: timed out after %d s" % TIMEOUT_S
    except OSError as error:
        return None, "fail: " + brief(str(error))
    return done, (done.stdout or "") + (done.stderr or "")


def names(items):
    return "set:" + json.dumps(sorted(items))


def entries(pattern, regex=None):
    folders = sorted(glob.glob(expand(pattern)))
    if not folders or not os.path.isdir(folders[0]):
        return "absent"
    return names(n for n in os.listdir(folders[0]) if (re.search(regex, n) if regex else not n.startswith(".")))


def distinfo(pattern):
    folders = sorted(glob.glob(expand(pattern)))
    if not folders:
        return "absent"
    found = []
    for name in os.listdir(folders[0]):
        match = re.match(r"(.+?)-([^-]+)\.dist-info$", name)
        if match:
            found.append("%s==%s" % (re.sub(r"[-_.]+", "-", match.group(1)).lower(), match.group(2)))
    return names(found)


def keys(path, at=None, depth=1):
    try:
        data = json.load(open(expand(path)))
    except FileNotFoundError:
        return "absent"
    except (OSError, ValueError) as error:
        return "fail: " + brief(str(error))
    if at:
        data = data.get(at, {})
    if depth == 1:
        return names(data)
    return names("%s/%s" % (kind, key) for kind, value in data.items() if isinstance(value, dict) for key in value)


def gitconfig(key):
    parser = configparser.RawConfigParser(strict=False)
    try:
        parser.read(HOME + "/.gitconfig")
    except configparser.Error as error:
        return "fail: " + brief(str(error))
    section, option = key.rsplit(".", 1)
    values = [parser.get(s, option) for s in parser.sections() if (s == section or s.startswith(section + " ")) and parser.has_option(s, option)]
    if not values:
        return "absent"
    return "=" + values[0] if key == "user.email" else "ok"


def ini(path, key):
    parser = configparser.RawConfigParser(strict=False)
    if not parser.read(expand(path)):
        return "absent"
    for section in parser.sections():
        if parser.has_option(section, key):
            return "=" + parser.get(section, key)
    return "absent"


def port(number):
    try:
        socket.create_connection(("127.0.0.1", number), timeout=5).close()
        return "ok"
    except OSError:
        return "fail: nothing answers on 127.0.0.1:%d" % number


LAUNCHD = {}
LAUNCHD_LOCK = threading.Lock()


def launchd(label):
    with LAUNCHD_LOCK:
        if "labels" not in LAUNCHD:
            done, text = run(["launchctl", "list"])
            LAUNCHD["labels"] = set(line.split("\t")[-1] for line in done.stdout.splitlines()) if done is not None and done.returncode == 0 else text
    labels = LAUNCHD["labels"]
    if isinstance(labels, str):
        return "fail: launchctl list: " + labels
    return "ok" if label in labels else "absent"


def service(unit):
    done, text = run(["systemctl", "--user", "is-active", unit])
    if done is None:
        return text
    return "ok" if done.returncode == 0 else "fail: " + (brief(text) or "exit %d" % done.returncode)


KNOWN = {}
READ_VERSIONS = {}


def version_from_path(real):
    """A CLI's version read from where it is installed: a Homebrew Cellar or Caskroom folder, an npm package.json or a versions/<v> file."""
    match = re.search(r"/(?:Cellar|Caskroom)/[^/]+/([^/]+)", real) or re.search(r"/versions/v?(\d+(?:\.\d+)+)$", real)
    if match:
        found = VERSION.search(match.group(1).split(",")[0])
        return found.group(0) if found else None
    folder = os.path.dirname(real)
    while "/node_modules/" in folder + "/":
        try:
            data = json.load(open(os.path.join(folder, "package.json")))
            return None if data.get("name") == "corepack" else data.get("version")
        except (OSError, ValueError):
            folder = os.path.dirname(folder)
    return None


def version(argv, host, cwd=None):
    if host == "box":
        done, text = run(argv, cwd)
        if done is None:
            return text
        found = VERSION.search(text)
        return "v:" + found.group(0) if found else "fail: no version in " + brief(text, 80)
    path = which(argv[0])
    if not path:
        return "absent"
    real = os.path.realpath(path)
    read = None if cwd else version_from_path(real)
    if read:
        return "v:" + read
    stamp = "%s@%d" % (real, int(os.stat(real).st_mtime))
    if cwd:
        stamp += "@%d" % int(os.stat(os.path.join(expand(cwd), "package.json")).st_mtime)
    known = KNOWN.get(argv[0])
    if known and known.get("stamp") == stamp:
        READ_VERSIONS[argv[0]] = known
        return known["value"]
    done, text = run(argv, cwd)
    if done is None:
        return text
    found = VERSION.search(text)
    value = "v:" + found.group(0) if found else "fail: no version in " + brief(text, 80)
    if found:
        READ_VERSIONS[argv[0]] = {"stamp": stamp, "value": value}
    return value


def mcp(name):
    try:
        server = json.load(open(HOME + "/.prime/agent/settings.json")).get("mcpServers", {}).get(name)
    except (OSError, ValueError) as error:
        return "fail: settings.json: " + brief(str(error))
    if not server or not server.get("command"):
        return "absent"
    command = which(server["command"])
    if not command:
        return "fail: %s is missing" % server["command"]
    child = subprocess.Popen([command] + server.get("args", []), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=dict(ENV, **server.get("env", {})), text=True, bufsize=1)
    deadline = time.time() + TIMEOUT_S

    def send(message):
        child.stdin.write(json.dumps(message) + "\n")
        child.stdin.flush()

    def answer(want):
        while time.time() < deadline:
            ready, _, _ = select.select([child.stdout], [], [], 0.5)
            if not ready:
                if child.poll() is not None:
                    return None
                continue
            line = child.stdout.readline()
            if not line:
                return None
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("id") == want:
                return message
        return None
    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "box-parity", "version": "0"}}})
        if not answer(1):
            return "fail: no initialize answer within %d s" % TIMEOUT_S
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = ((answer(2) or {}).get("result") or {}).get("tools")
        return "ok" if tools else "fail: tools/list gave no tools"
    except (OSError, ValueError) as error:
        return "fail: " + brief(str(error))
    finally:
        child.kill()


def git_bytes(args, data=None):
    done = subprocess.run(["git", "-C", REPO] + args, input=data, capture_output=True, timeout=TIMEOUT_S, env=ENV)
    if done.returncode != 0:
        raise RuntimeError("git %s: %s" % (args[0], brief(done.stderr.decode("utf-8", "replace"))))
    return done.stdout


def path_key(path, blob):
    return hashlib.sha1((path + "\0" + blob).encode()).hexdigest()[:12]


# The box checkout's dev branch (c119): us-metal02 works on dev/sieun since the 2026-10-27 08:17Z cutover from sieun/dev.
SHARED = "dev/sieun"


def branch(host):
    """The branch a host's commits are read from: the box's dev branch, or the Mac checkout's own `agent.branch` (c119), else its current branch."""
    if host == "box":
        return SHARED
    for args in (["config", "--get", "agent.branch"], ["branch", "--show-current"]):
        done = subprocess.run(["git", "-C", REPO] + args, capture_output=True, text=True, timeout=TIMEOUT_S, env=ENV)
        if done.stdout.strip():
            return done.stdout.strip()
    return SHARED


# A commit's patch-id never changes, so the box keeps each one by hash here. On us-metal02 on 10-19 at 21:25Z, `git log -p` of its last 2000
# commits took 4.8 s of CPU and 10 s of wall time, and in 3 of the 7 box parity runs that evening, at load 420 on 80 cores, it ran past TIMEOUT_S.
PATCH_CACHE = HOME + "/.cache/box-parity/patch-ids.json"


def patch_ids(shas, host):
    """Each commit's `git patch-id --stable` of its diff without context lines (a merge diffs against its first parent), or "" for an empty diff.

    The box reads PATCH_CACHE, runs `git log -p` only for the commits it lacks and writes the cache back with just these commits. The Mac side
    only reads, so it computes all of its 100.
    """
    cached = {}
    if host == "box":
        try:
            cached = json.load(open(PATCH_CACHE))
        except (OSError, ValueError):
            cached = {}
    todo = [sha for sha in shas if sha not in cached]
    if todo:
        diffs = git_bytes(["log", "--stdin", "--no-walk=unsorted", "-p", "-U0", "--format=commit %H", "--no-renames", "--diff-merges=first-parent"],
                          ("\n".join(todo) + "\n").encode())
        found = dict((sha, pid) for pid, sha in (line.split() for line in git_bytes(["patch-id", "--stable"], diffs).decode().splitlines() if line.strip()))
        cached.update((sha, found.get(sha, "")) for sha in todo)
    kept = dict((sha, cached[sha]) for sha in shas)
    if host == "box" and todo:
        part = "%s.%d" % (PATCH_CACHE, os.getpid())
        try:
            os.makedirs(os.path.dirname(PATCH_CACHE), exist_ok=True)
            with open(part, "w") as out:
                json.dump(kept, out)
            os.replace(part, PATCH_CACHE)
        except OSError:
            pass
    return kept


def commits(host):
    """The host's last commits on branch(host) as "commits:<json>", so the precheck counts a Mac commit as on the box under another hash.

    Each commit gives its 10-character hash, the `git patch-id --stable` of its diff without context lines (a merge diffs against its first
    parent), so a change carried onto another base keeps its id, and one key per path it touched from the path and the bytes it wrote. The Mac
    sends its last 100 as one list entry each, with whether its own origin/<branch> holds it, so a commit it never pushed is told apart from one the
    box failed to fetch. The box sends the hashes of every commit dev/sieun holds, the patch-ids and path keys of its last 2000, plus the hashes
    its fetched origin branches hold beyond dev/sieun, such as the Mac's pushed dev/sieun-mac (c119). Hashes cover all of the box branch because on
    10-21 the box's last 2000 reached back only 33 hours (2214 commits in 34 h), so 8 Mac commits sieun/dev held fell out of the window and
    turned the row off; the full list is 16148 hashes, 0.4 s and 210 KB.
    """
    count = "100" if host == "mac" else "2000"
    name = branch(host)
    try:
        raw = git_bytes(["log", "--no-abbrev", "--raw", "--format=@%H", "-n", count, "--no-renames", "--diff-merges=first-parent", name]).decode("utf-8", "replace")
        patch_of = patch_ids([line[1:] for line in raw.splitlines() if line.startswith("@")], host)
        if host == "box":
            held = git_bytes(["rev-list", name]).decode().split()
            fetched = git_bytes(["rev-list", "--remotes=origin", "--not", name]).decode().split()
        else:
            pushed = "refs/remotes/origin/" + name
            has_pushed = subprocess.run(["git", "-C", REPO, "rev-parse", "-q", "--verify", pushed], capture_output=True, timeout=TIMEOUT_S, env=ENV).returncode == 0
            unpushed = set(git_bytes(["rev-list", "-n", count, name] + (["--not", pushed] if has_pushed else [])).decode().split())
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return "fail: " + brief(str(error))
    order, wrote = [], {}
    for line in raw.splitlines():
        if line.startswith("@"):
            order.append(line[1:])
            wrote[line[1:]] = []
        elif line.startswith(":") and order:
            meta, path = line.split("\t", 1)
            wrote[order[-1]].append((path, meta.split()[3]))
    if host == "box":
        return "commits:" + json.dumps({"ids": [sha[:10] for sha in held], "patches": sorted(set(pid[:16] for pid in patch_of.values() if pid)),
                                        "bytes": sorted(set(path_key(path, blob) for files in wrote.values() for path, blob in files)),
                                        "fetched": sorted(sha[:10] for sha in fetched)})
    return "commits:" + json.dumps([[sha[:10], patch_of.get(sha, "")[:16], [path_key(path, blob) for path, blob in wrote[sha]], sha not in unpushed] for sha in order])


def at_tip(paths, host):
    """The repo paths whose folder is a tree on branch(host), so a file left in a folder the tip deleted (apps/research-app, c5fc7d1de2) is no tool."""
    folders = sorted(set(os.path.dirname(path) for path in paths) - {""})
    listed = git_bytes(["ls-tree", "-d", "--name-only", branch(host), "--"] + folders).decode().splitlines() if folders else []
    return [path for path in paths if os.path.dirname(path) in set(listed) | {""}]


def blobs(path, host):
    """A file's git blob hash, then on the box every blob its real path held at a commit its checkout's HEAD descends from, as "blobs:<json list>".

    ~/.prime/agent/AGENTS.md links into the sieun-pi checkout on the box and into a runtime release on the Mac, which rolls later, so a Mac file
    the box checkout once held is the box being ahead. The Mac side sends only its file's hash.
    """
    try:
        data = open(expand(path), "rb").read()
    except FileNotFoundError:
        return "absent"
    found = [hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()]
    if host == "box":
        real = os.path.realpath(expand(path))
        done = subprocess.run(["git", "-C", os.path.dirname(real), "log", "--raw", "--no-abbrev", "--no-renames", "--format=", "HEAD", "--", os.path.basename(real)],
                              capture_output=True, text=True, timeout=TIMEOUT_S, env=ENV)
        if done.returncode == 0:
            found += [line.split()[3] for line in done.stdout.splitlines() if line.startswith(":") and not set(line.split()[3]) <= {"0"}]
    return "blobs:" + json.dumps(found)


def probe(spec, host):
    kind = next(k for k in spec if k not in ("expect", "cwd", "pattern", "at", "depth", "key", "names", "atTip", "intended", "shared"))
    if host == "mac" and kind not in READS:
        return "fail: %s is not a read, so the Mac side never runs it" % kind
    if kind == "const":
        return spec["const"]
    if kind == "panel":
        return "panel"
    if kind == "tip":
        return commits(host)
    if kind == "path":
        return "ok" if os.path.exists(expand(spec["path"])) else "absent"
    if kind == "which":
        return "ok" if which(spec["which"]) else "absent"
    if kind == "glob":
        found = sorted(glob.glob(expand(spec["glob"])))
        if spec.get("names"):
            paths = [os.path.relpath(f, REPO) for f in found]
            return names(at_tip(paths, host) if spec.get("atTip") else paths)
        return "ok" if found else "absent"
    if kind == "ls":
        return entries(spec["ls"], spec.get("pattern"))
    if kind == "keys":
        return keys(spec["keys"], spec.get("at"), spec.get("depth", 1))
    if kind == "sha":
        try:
            return "sha:" + hashlib.sha256(open(expand(spec["sha"]), "rb").read()).hexdigest()[:16]
        except FileNotFoundError:
            return "absent"
    if kind == "blob":
        return blobs(spec["blob"], host)
    if kind == "distinfo":
        return distinfo(spec["distinfo"])
    if kind == "gitconfig":
        return gitconfig(spec["gitconfig"])
    if kind == "ini":
        return ini(spec["ini"], spec["key"])
    if kind == "port":
        return port(spec["port"])
    if kind == "launchd":
        return launchd(spec["launchd"])
    if kind == "unit":
        return service(spec["unit"])
    if kind == "mcp":
        return mcp(spec["mcp"])
    if kind == "version":
        return version(spec["version"], host, spec.get("cwd"))
    done, text = run(spec[kind], spec.get("cwd"))
    if done is None:
        return text
    if done.returncode != 0:
        return "fail: exit %d: %s" % (done.returncode, brief(text))
    if spec.get("expect"):
        return "ok" if re.search(spec["expect"], text, re.M) else "fail: " + brief(text)
    return "=" + brief(done.stdout, 200) if kind == "out" else "ok"


def safe(spec, host):
    try:
        return probe(spec, host)
    except Exception as error:
        return "fail: probe error " + brief(repr(error))


def main():
    payload = json.loads(base64.b64decode(sys.argv[1]))
    host = payload["host"]
    KNOWN.update(payload.get("known") or {})
    start = time.time()
    jobs = [(row["id"], spec) for row in payload["rows"] for spec in row.get(host, row.get("probes", []))]
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda job: (job[0], safe(job[1], host)), jobs))
    values = {}
    for row_id, value in results:
        values.setdefault(row_id, []).append(value)
    print(json.dumps({"host": host, "values": values, "versions": READ_VERSIONS, "ms": int((time.time() - start) * 1000)}))


if __name__ == "__main__":
    main()

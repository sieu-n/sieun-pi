"""The Box tools parity duty's probe: one host's side of each tool row in box-parity.rows.json, printed as one JSON object.

The precheck (box-parity.ts) runs this file on the box and, over one `ssh mac`, on the owner's MacBook Pro. On the Mac it only reads: file
and folder presence, hashes, JSON keys, localhost ports, one `launchctl list`, and a CLI version from its install path (Homebrew Cellar,
npm package.json); a CLI whose path carries no version is run with `--version` once and cached by its path and mtime.
On the box it also makes the real calls: logins, kernel imports and MCP initialize plus tools/list. Python 3.9 stdlib, because ssh on the
Mac starts /usr/bin/python3.
Usage: python3 box-parity-probe.py <base64 of {"host": "mac"|"box", "rows": [...], "known": {cli: version read}}>
A value is "ok", "absent", "fail: <why>", "v:<version>", "=<output>", "sha:<hex>" or "set:<json list>".
"""
import base64, configparser, glob, hashlib, json, os, re, select, socket, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
REPO = HOME + "/Documents/Github/auto-sns-agent"
TIMEOUT_S = 25
VERSION = re.compile(r"\d+(?:\.\d+)+[a-z]?")
READS = {"const", "path", "which", "glob", "ls", "keys", "sha", "port", "launchd", "version", "distinfo", "gitconfig", "ini", "tip"}


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


# The box's shared branch, where every checkout's work lands.
SHARED = "sieun/dev"


def branch(host):
    """The branch a host's commits are read from: the box's shared branch, or the Mac checkout's own `agent.branch` (c119), as asa-tip-sync reads it."""
    if host == "box":
        return SHARED
    done = subprocess.run(["git", "-C", REPO, "config", "--get", "agent.branch"], capture_output=True, text=True, timeout=TIMEOUT_S, env=ENV)
    return done.stdout.strip() or SHARED


def commits(host):
    """The host's last commits on branch(host) as "commits:<json>", so the precheck counts a Mac commit as on the box under another hash.

    Each commit gives its 10-character hash, the `git patch-id --stable` of its diff without context lines (a merge diffs against its first
    parent), so a change carried onto another base keeps its id, and one key per path it touched from the path and the bytes it wrote. The Mac
    sends its last 100 as one list entry each; the box sends the hashes, patch-ids and path keys of its last 2000 as three flat lists.
    """
    count = "100" if host == "mac" else "2000"
    try:
        diff = ["-n", count, "--no-renames", "--diff-merges=first-parent", branch(host)]
        raw = git_bytes(["log", "--no-abbrev", "--raw", "--format=@%H"] + diff).decode("utf-8", "replace")
        patches = git_bytes(["patch-id", "--stable"], git_bytes(["log", "-p", "-U0", "--format=commit %H"] + diff)).decode()
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
    patch_of = {sha: pid for pid, sha in (line.split() for line in patches.splitlines() if line.strip())}
    if host == "box":
        return "commits:" + json.dumps({"ids": [sha[:10] for sha in order], "patches": sorted(set(pid[:16] for pid in patch_of.values())),
                                        "bytes": sorted(set(path_key(path, blob) for files in wrote.values() for path, blob in files))})
    return "commits:" + json.dumps([[sha[:10], patch_of.get(sha, "")[:16], [path_key(path, blob) for path, blob in wrote[sha]]] for sha in order])


def at_tip(paths, host):
    """The repo paths whose folder is a tree on branch(host), so a file left in a folder the tip deleted (apps/research-app, c5fc7d1de2) is no tool."""
    folders = sorted(set(os.path.dirname(path) for path in paths) - {""})
    listed = git_bytes(["ls-tree", "-d", "--name-only", branch(host), "--"] + folders).decode().splitlines() if folders else []
    return [path for path in paths if os.path.dirname(path) in set(listed) | {""}]


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

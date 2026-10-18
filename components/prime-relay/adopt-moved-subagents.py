#!/usr/bin/env python3
"""Make a moved chat's subagents reachable on the box that now holds the chat.

Prime finds a stopped subagent through its spawn ledger (~/.prime/agent/rlm-ledger/<hash>.jsonl), one edge per child. The ledger is per
box and is seeded from old registries only when it is first created, so a chat tree copied in from another box brings its children's
files and rlm-subagent.json but no edges. The daemon then answers "Unknown active session" for every one of them, and the parent cannot
reach them by name either (10-18: 326 children of 10 moved chats on us-metal02).

This walks each root in the sessions dir, finds every sub-*/rlm-subagent.json child with no edge, and appends the spawn edge the daemon
would have written, parents before children. The ledger is append-only and multi-writer by design (one small O_APPEND write per line).
A child whose name is taken under its parent (the parent spawned a fresh copy after the move) gets " before move" added, so names stay
unique and the fresh copy keeps its name. Running it again appends nothing.

Usage: adopt-moved-subagents.py [--apply] [--root <session id prefix> ...]
"""
import argparse, datetime, glob, hashlib, json, os, sys

AGENT = os.path.expanduser(os.environ.get("PRIME_AGENT_DIR", "~/.prime/agent"))
SUFFIX = " before move"


def ledger_path(agent_dir):
    sessions = os.path.realpath(os.path.join(agent_dir, "sessions"))
    return os.path.join(agent_dir, "rlm-ledger", hashlib.sha256(sessions.encode()).hexdigest()[:16] + ".jsonl")


def read_ledger(path):
    edges = {}
    if os.path.exists(path):
        for line in open(path):
            if not line.strip():
                continue
            e = json.loads(line)
            key = (e.get("childId"), os.path.realpath(e["child"])) if "child" in e else None
            if e["op"] == "spawn":
                edges[key] = dict(e)
            elif e["op"] == "rename" and key in edges:
                edges[key]["name"] = e["name"]
            elif e["op"] == "delete" and key in edges:
                edges[key]["deleted"] = True
    return edges


def child_file(sub, meta):
    named = os.path.join(sub, os.path.basename(meta.get("sessionFile", "")))
    if os.path.isfile(named):
        return named
    files = [f for f in os.listdir(sub) if f.endswith(".jsonl") and f.count("-") == 4]
    return os.path.join(sub, files[0]) if len(files) == 1 else None


def missing_edges(agent_dir, edges, roots):
    known = {child for (_, child) in edges}
    names = {}
    for e in edges.values():
        if not e.get("deleted"):
            names.setdefault(os.path.realpath(e["parent"]), set()).add(e["name"])
    out = []

    def walk(parent_file, folder, depth):
        for sub in sorted(glob.glob(os.path.join(folder, "sub-*"))):
            try:
                meta = json.load(open(os.path.join(sub, "rlm-subagent.json")))
            except (OSError, ValueError):
                continue
            path = child_file(sub, meta)
            if not path or meta.get("status") == "deleted":
                continue
            child, parent = os.path.realpath(path), os.path.realpath(parent_file)
            if child not in known:
                taken = names.setdefault(parent, set())
                name = meta.get("sessionName") or meta["childId"]
                if name in taken:
                    base, n = name + SUFFIX, 2
                    name = base
                    while name in taken:
                        name, n = f"{base} {n}", n + 1
                taken.add(name)
                out.append({"v": 1, "op": "spawn", "childId": meta["childId"], "parent": parent, "child": child, "depth": depth, "name": name})
            walk(path, sub, depth + 1)

    for root in sorted(glob.glob(os.path.join(agent_dir, "sessions", "*.jsonl"))):
        rid = os.path.basename(root)[:-6]
        if roots and not any(rid.startswith(r) for r in roots):
            continue
        walk(root, os.path.join(agent_dir, "session-artifacts", rid), 1)
    return sorted(out, key=lambda e: e["depth"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="append the edges (default: print them)")
    ap.add_argument("--root", action="append", default=[], help="only this root session (id prefix); repeatable")
    args = ap.parse_args()
    path = ledger_path(AGENT)
    todo = missing_edges(AGENT, read_ledger(path), args.root)
    for e in todo:
        print(json.dumps({"childId": e["childId"], "depth": e["depth"], "name": e["name"], "child": e["child"]}))
    if args.apply and todo:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            for e in todo:
                e["at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                os.write(fd, (json.dumps({k: e[k] for k in ("v", "op", "at", "childId", "parent", "child", "depth", "name")}, separators=(",", ":")) + "\n").encode())
            os.fsync(fd)
        finally:
            os.close(fd)
    print(f"{'appended' if args.apply else 'would append'} {len(todo)} edges to {path}", file=sys.stderr)


if __name__ == "__main__":
    main()

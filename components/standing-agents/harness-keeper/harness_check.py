#!/usr/bin/env python3
"""Find near-duplicate and dead-path entries in the global harness store.

harness-keeper's wake precheck runs this before the agent starts (standing-agents.json), and the
agent acts on the output with harness_edit.py. The 2026-11-20 memory review measured 16 pairs
(30 entries) at TF-IDF cosine 0.45 or more and 15 entries that cite a repo path git history shows
was moved or deleted (~/work/agent-memory-review/memory-measurer.md, section 4). Nobody curated
the store between 11-10 and 11-20.

Entries whose title or path names one sw factory agent are listed under agent_scoped and left out
of both checks, because the per-agent mem-<slug> jobs move those into the agents' own stores.

usage: harness_check.py <out.json> [--store <harness_state.json>] [--repo <dir>]... [--agents <ideal.json>]
"""
import argparse
import collections
import datetime
import json
import math
import os
import re
import subprocess

HOME = os.path.expanduser("~")
DUP_COSINE = 0.45  # the review's cut: 16 pairs at 0.45 against 61 at 0.35, which held unrelated notes
TOKEN = re.compile(r"[a-z0-9_]{3,}")
REPO_ROOTS = ("apps", "packages", "components", "scripts", "legacy", "skills", "config", "docs", "tools", "services", "infra", "src")
PATH = re.compile(r"(?<![\w/.~@-])((?:%s)/[\w.@+-]+(?:/[\w.@+-]+)*)" % "|".join(REPO_ROOTS))


def git(repo, *args):
    out = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else ""


def agent_terms(ideal):
    try:
        agents = json.load(open(ideal))["agents"]
    except (OSError, ValueError, KeyError):
        return {}
    terms = {}
    for a in agents:
        slug = a["slug"]
        words = {slug, slug.replace("-", " "), slug.replace("-", "_")}
        terms[slug] = re.compile(r"(?<![a-z0-9])(%s)(?![a-z0-9])" % "|".join(re.escape(w) for w in sorted(words)))
    return terms


def scoped_agents(entry, terms):
    head = f"{entry.get('title', '')} {entry.get('path', '')} {entry.get('id', '')}".lower()
    return sorted(slug for slug, rx in terms.items() if rx.search(head))


def near_duplicates(entries):
    docs = {e["id"]: collections.Counter(TOKEN.findall(f"{e.get('title', '')} {e.get('content', '')}".lower())) for e in entries}
    df = collections.Counter(t for c in docs.values() for t in c)
    n = len(docs)
    vecs = {}
    for eid, counts in docs.items():
        v = {t: (1 + math.log(k)) * math.log(n / df[t]) for t, k in counts.items() if df[t] < n}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs[eid] = {t: x / norm for t, x in v.items()}
    index = collections.defaultdict(list)
    for eid, v in vecs.items():
        for t, x in v.items():
            index[t].append((eid, x))
    pairs = []
    for a, va in vecs.items():
        scores = collections.Counter()
        for t, x in va.items():
            for b, y in index[t]:
                if b > a:
                    scores[b] += x * y
        pairs += [(a, b, round(s, 3)) for b, s in scores.items() if s >= DUP_COSINE]
    return sorted(pairs, key=lambda p: -p[2])


def clusters(pairs):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, _ in pairs:
        parent[find(a)] = find(b)
    groups = collections.defaultdict(set)
    for a, b, _ in pairs:
        groups[find(a)].update((a, b))
    return [sorted(g) for g in groups.values()]


def tail(a, b):
    """How many trailing path segments a and b share."""
    n = 0
    for x, y in zip(reversed(a.split("/")), reversed(b.split("/"))):
        if x != y:
            break
        n += 1
    return n


class Repos:
    def __init__(self, roots):
        self.roots = [r for r in roots if os.path.isdir(os.path.join(r, ".git"))]
        self.files = {r: set(git(r, "ls-tree", "-r", "--name-only", "HEAD").splitlines()) for r in self.roots}
        self.dirs = {r: {f.rsplit("/", i)[0] for f in fs for i in range(1, f.count("/") + 1)} for r, fs in self.files.items()}
        self.by_name = {}
        for r in self.roots:
            self.by_name[r] = collections.defaultdict(list)
            for f in self.files[r] | self.dirs[r]:
                self.by_name[r][f.rsplit("/", 1)[-1]].append(f)
        self.history = {}

    def exists(self, token):
        # A path git dropped can still be on disk, such as apps/llm-wiki/content, which left git
        # on 11-03 (b767305544) and became a link to ~/.pi/wiki/content.
        return any(token in self.files[r] or token in self.dirs[r] or os.path.exists(os.path.join(r, token)) for r in self.roots)

    def dead(self, token):
        """The newest commit that touched token in a repo whose HEAD lacks it, plus where it went."""
        if token not in self.history:
            found = None
            for r in self.roots:
                last = git(r, "log", "--all", "-1", "--format=%h %cs", "--", token)
                if last:
                    renamed = git(r, "log", "--all", "-1", "-M", "--diff-filter=R", "--name-status", "--format=", "--", token).split("\t")
                    depth = token.count("/")
                    same_name = self.by_name[r].get(token.rsplit("/", 1)[-1], ())
                    moved = sorted((f for f in same_name if tail(f, token) >= 2 or f.count("/") == depth), key=lambda f: -tail(f, token))
                    found = {"repo": r, "last_commit": last, "renamed_to": renamed[2] if len(renamed) == 3 and renamed[1] == token else None, "now_at": moved[:3]}
                    break
            self.history[token] = found
        return self.history[token]


def dead_paths(entries, repos):
    out = []
    for e in entries:
        tokens = sorted({m.rstrip(".,:;)'`") for m in PATH.findall(e.get("content", "") + " " + e.get("title", ""))})
        tokens = [t for t in tokens if "*" not in t and "..." not in t and not repos.exists(t)]
        gone = [{"path": t, **d} for t in tokens if (d := repos.dead(t))]
        if gone:
            out.append({"kind": e["kind"], "id": e["id"], "title": e.get("title", ""), "updated_at": e.get("updated_at"), "dead": gone})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--store", default=f"{HOME}/.prime/agent/harness/harness_state.json")
    ap.add_argument("--repo", action="append", default=None)
    ap.add_argument("--agents", default=f"{HOME}/work/agent-memory/ideal.json")
    args = ap.parse_args()
    repos = Repos(args.repo or [f"{HOME}/src/sieun-pi", f"{HOME}/Documents/Github/auto-sns-agent"])
    terms = agent_terms(args.agents)
    store = json.load(open(args.store))["entries"]
    entries, scoped = [], []
    for kind in ("prompt", "memory"):
        for e in store.get(kind, {}).values():
            e = {**e, "kind": kind}
            slugs = scoped_agents(e, terms)
            if len(slugs) == 1:
                scoped.append({"kind": kind, "id": e["id"], "agent": slugs[0]})
            else:
                entries.append(e)
    by_id = {(e["kind"], e["id"]): e for e in entries}
    dup_groups = []
    for kind in ("prompt", "memory"):
        pairs = near_duplicates([e for e in entries if e["kind"] == kind])
        for group in clusters(pairs):
            members = [by_id[(kind, i)] for i in group]
            dup_groups.append({
                "kind": kind,
                "pairs": [p for p in pairs if p[0] in group],
                "entries": [{"id": m["id"], "title": m.get("title", ""), "path": m.get("path"), "created_at": m.get("created_at"),
                             "updated_at": m.get("updated_at"), "chars": len(m.get("content", ""))} for m in members],
            })
    dead = dead_paths(entries, repos)
    result = {
        "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "store": args.store,
        "counts": {"checked": len(entries), "agent_scoped": len(scoped), "dup_groups": len(dup_groups),
                   "dup_entries": sum(len(g["entries"]) for g in dup_groups), "dead_path_entries": len(dead)},
        "dup_cosine": DUP_COSINE,
        "repos": repos.roots,
        "duplicates": dup_groups,
        "dead_paths": dead,
        "agent_scoped": scoped,
    }
    json.dump(result, open(args.out, "w"), indent=1)
    print(json.dumps(result["counts"]))


if __name__ == "__main__":
    main()

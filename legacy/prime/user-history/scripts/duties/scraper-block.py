#!/usr/bin/env python3
"""Add one scraper client to the Vercel Firewall rule `scraper-blocklist` on auto-sns-search and publish it.

Each client is one OR group of that rule. Usage, from any directory:
  python3 legacy/prime/user-history/scripts/duties/scraper-block.py --label "<who, date>" \
      [--ua-sub "<UA substring>" | --ua-re "<UA regex>"] [--asn 14061 ...] [--cidr 1.2.3.0/24 ...] [--ip 1.2.3.4 ...] \
      [--public-only] [--dry-run]
  python3 legacy/prime/user-history/scripts/duties/scraper-block.py --label "<who, date>" --groups-file <file.json> [--dry-run]
--groups-file takes {"groups": [{"conditions": [...]}, ...]} in Vercel's condition shape (for header, query or cookie conditions) and adds each group as is.
A group needs a UA or a network (asn, cidr or ip), and a group with no UA always skips declared search and AI bots.
--public-only limits the group to the public database pages (the d5 path regex). Every add appends a line to ~/work/scraper-watch/blocklist.jsonl, which names each group.
A denied request shows in the Vercel drain (prod ClickHouse otel.otel_logs, service search) with LogAttributes['vercel.source'] = 'firewall'
and LogAttributes['vercel.proxy.wafRule'] = 'rule_scraper_blocklist_5OLTML'; a blocked client has no 'lambda' rows after the publish.
Two writers of the firewall share one Vercel draft, so the script prints `vercel firewall diff` before it publishes.
"""
import argparse, json, os, subprocess, sys, datetime

LEDGER = os.path.expanduser("~/work/scraper-watch/blocklist.jsonl")
SEARCH = "/home/sieun/Documents/Github/auto-sns-agent/apps/search"
RULE = "scraper-blocklist"
SCOPE = ["--scope", "sieuns-projects"]


def vercel(*args: str) -> str:
    out = subprocess.run(["vercel", *args, *SCOPE], cwd=SEARCH, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"vercel {' '.join(args)} failed:\n{out.stdout}\n{out.stderr}")
    return out.stdout


def as_json(text: str) -> dict:
    return json.loads(text[text.index("{"):])


def d5_parts() -> tuple[str, str, list[dict]]:
    """The public database path regex, the declared-bot regex and our own box IPs, read live from d5's rule."""
    conds = as_json(vercel("firewall", "rules", "inspect", "public-db-bot-ua", "--json"))["conditionGroup"][0]["conditions"]
    path = next(c["value"] for c in conds if c["type"] == "path")
    bots = next(c["value"] for c in conds if c["type"] == "user_agent" and c.get("neg"))
    ours = [c for c in conds if c["type"] == "ip_address" and c.get("neg")]
    return path, bots, ours


def net(kind: str, values: list[str]) -> dict:
    if len(values) == 1:
        return {"type": kind, "op": "eq", "value": values[0]}
    return {"type": kind, "op": "inc", "value": values}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--ua-sub")
    ap.add_argument("--ua-re")
    ap.add_argument("--asn", nargs="*", default=[])
    ap.add_argument("--cidr", nargs="*", default=[])
    ap.add_argument("--ip", nargs="*", default=[])
    ap.add_argument("--public-only", action="store_true")
    ap.add_argument("--groups-file")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.groups_file:
        groups = [g["conditions"] for g in json.load(open(a.groups_file))["groups"]]
    elif a.ua_sub or a.ua_re or a.asn or a.cidr or a.ip:
        groups = [flag_group(a)]
    else:
        sys.exit("a group needs a UA or a network, or pass --groups-file")
    rule = as_json(vercel("firewall", "rules", "inspect", RULE, "--json"))
    body = {k: rule[k] for k in ("name", "description", "active", "conditionGroup", "action")}
    body["conditionGroup"] += [{"conditions": group} for group in groups]
    print(json.dumps(groups, indent=1))
    if a.dry_run:
        return
    vercel("firewall", "rules", "edit", RULE, "--json", json.dumps(body), "--yes")
    print(vercel("firewall", "diff"))
    print(vercel("firewall", "publish", "--yes"))
    at = datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
    first = len(body["conditionGroup"]) - len(groups) + 1
    with open(LEDGER, "a") as f:
        for i, group in enumerate(groups):
            f.write(json.dumps({"at": at, "label": a.label, "group": first + i, "conditions": group}) + "\n")


def flag_group(a: argparse.Namespace) -> list[dict]:
    path, bots, ours = d5_parts()
    group: list[dict] = []
    if a.public_only:
        group.append({"type": "path", "op": "re", "value": path})
    if a.ua_sub:
        group.append({"type": "user_agent", "op": "sub", "value": a.ua_sub})
    if a.ua_re:
        group.append({"type": "user_agent", "op": "re", "value": a.ua_re})
    if a.asn:
        group.append(net("geo_as_number", a.asn))
    if a.cidr or a.ip:
        group.append(net("ip_address", a.cidr + a.ip))
    if not (a.ua_sub or a.ua_re):
        group.append({"type": "user_agent", "op": "re", "neg": True, "value": bots})
    return group + ours


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Block one scraper client on virev.ai: add a group to the scraper-blocklist rule in auto-sns-agent's apps/search/firewall.json,
publish it with `node scripts/repo/vercel/firewall.mjs apply`, and commit the file with commit.mjs on the checkout's dev branch.

Usage, from any directory:
  python3 legacy/prime/user-history/scripts/duties/scraper-block.py --label "<who, date, who found it>" \
      [--ua-sub "<UA substring>" | --ua-re "<UA regex>"] [--asn 14061 ...] [--cidr 1.2.3.0/24 ...] [--ip 1.2.3.4 ...] \
      [--public-only] [--dry-run]
  python3 legacy/prime/user-history/scripts/duties/scraper-block.py --label "<who, date>" --groups-file <file.json> [--dry-run]
A group needs a UA or a network (asn, cidr or ip). A group with no UA condition skips the allow list (search indexing bots and
link previews, "$allow_ua"), every group skips our own boxes, and --public-only limits it to the public data pages and their
APIs ("$public_data"). --groups-file takes {"groups": [{"conditions": [...]}]} in the file's condition shape, for header,
query or cookie conditions. --dry-run prints the group and changes nothing.
A denied request shows in the Vercel drain (prod ClickHouse otel.otel_logs, service search) with
LogAttributes['vercel.source'] = 'firewall' and LogAttributes['vercel.proxy.wafRule'] = 'rule_scraper_blocklist_5OLTML';
a blocked client has no 'lambda' rows after the publish.
"""
import argparse, datetime, json, os, subprocess, sys

REPO = "/home/sieun/Documents/Github/auto-sns-agent"
FILE = "apps/search/firewall.json"
RULE = "scraper-blocklist"


def run(*cmd: str) -> str:
    out = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    sys.stdout.write(out.stdout + out.stderr)
    if out.returncode != 0:
        sys.exit(f"{' '.join(cmd[:3])} failed")
    return out.stdout


def net(kind: str, values: list[str]) -> dict:
    return {"type": kind, "op": "eq", "value": values[0]} if len(values) == 1 else {"type": kind, "op": "inc", "value": values}


def flag_group(a: argparse.Namespace) -> list[dict]:
    group: list[dict] = []
    if a.public_only:
        group.append({"type": "path", "op": "re", "value": "$public_data"})
    if a.ua_sub:
        group.append({"type": "user_agent", "op": "sub", "value": a.ua_sub})
    if a.ua_re:
        group.append({"type": "user_agent", "op": "re", "value": a.ua_re})
    if a.asn:
        group.append(net("geo_as_number", a.asn))
    if a.cidr or a.ip:
        group.append(net("ip_address", a.cidr + a.ip))
    if not (a.ua_sub or a.ua_re):
        group.append({"type": "user_agent", "op": "re", "neg": True, "value": "$allow_ua"})
    return group + [{"use": "skip_own_ips"}]


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
    print(json.dumps(groups, indent=1))
    if a.dry_run:
        return
    path = os.path.join(REPO, FILE)
    firewall = json.load(open(path))
    rule = next(r for r in firewall["rules"] if r["name"] == RULE)
    today = datetime.datetime.now(datetime.UTC).date().isoformat()
    rule["groups"] += [{"label": a.label, "added": today, "conditions": group} for group in groups]
    with open(path, "w") as f:
        f.write(json.dumps(firewall, indent="\t", ensure_ascii=False) + "\n")
    run("node", "scripts/repo/vercel/firewall.mjs", "apply")
    run("node", "scripts/repo/agent/commit.mjs", "-m", f"chore(search): the firewall blocks {a.label}", FILE)


if __name__ == "__main__":
    main()

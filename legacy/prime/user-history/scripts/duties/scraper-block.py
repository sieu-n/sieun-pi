#!/usr/bin/env python3
"""Block one scraper client on virev.ai: add a group to the scraper-blocklist rule (deny) in auto-sns-agent's apps/search/firewall.json,
or to scraper-challenge (challenge) when it is a no-referer home-proxy fleet a person's plain visit can also match (verdict below),
publish it with `node scripts/repo/vercel/firewall.mjs apply`, and commit the file with commit.mjs on the checkout's dev branch.
It first runs `firewall.mjs diff` on the unedited file and refuses when the file differs from the live config (drift below), so it never
publishes a file older than what is live. On 11-15 dev/sieun's file predated staging 6df678ce83, and an apply would have sent 9 groups
back to deny and brought back scraper-blocklist-2. The token for our own browser comes from FIREWALL_OWN_UA, read from
apps/ci-specs/.env.staging with dotenvx when the env lacks it.

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
RULES = {"deny": "scraper-blocklist", "challenge": "scraper-challenge"}
# The scraper-challenge rule as auto-sns-agent d765ee8401 adds it, for a firewall.json from before that commit.
CHALLENGE_RULE = {
    "name": "scraper-challenge",
    "description": "Scraper fleets whose request a real browser can also send on a plain visit: a current or recent desktop browser UA with no "
    "referer or a bare Google referer. A challenge lets a person through and stops the fleet: of 15,305 IP and UA pairs that public-db-fake-chrome "
    "challenged on virev.ai from 11-08 to 11-15, 3 ever loaded a public data page. A group with a sign no person sends, such as a bot UA, a "
    "hosting ASN or a UA no browser ships, stays in scraper-blocklist.",
    "active": True,
    "action": {"action": "challenge"},
    "groups": [],
}


def drift(diff_out: str) -> list[str]:
    """The lines of `firewall.mjs diff` output that say the file and the live config differ: an add, replace, remove or unmanaged rule."""
    return [line for line in diff_out.splitlines() if line.split(" ", 1)[0] in ("add", "replace", "remove", "unmanaged")]


def own_ua() -> str:
    """FIREWALL_OWN_UA from the env, or from apps/ci-specs/.env.staging through dotenvx; never printed."""
    if os.environ.get("FIREWALL_OWN_UA"):
        return os.environ["FIREWALL_OWN_UA"]
    out = subprocess.run(["npx", "dotenvx", "get", "FIREWALL_OWN_UA", "-f", "apps/ci-specs/.env.staging"], cwd=REPO, capture_output=True, text=True)
    lines = out.stdout.strip().splitlines()
    if out.returncode != 0 or not lines:
        sys.exit("could not read FIREWALL_OWN_UA from apps/ci-specs/.env.staging")
    return lines[-1]


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


def verdict(group: list[dict]) -> str:
    """challenge for a no-referer group with no network, no Google UA and a UA regex or substring (a home-proxy fleet a person's direct visit
    can also match, 11-15), deny for the rest: a hosting ASN or IP list, a fake Googlebot from outside Google's network, a bare Google referer
    (the X11 fleet), an exact UA list copied from one fleet's requests (of the 11-03 group's 32,764 denied IP and UA pairs from 11-08 to 11-15,
    0 opened a page with a virev.ai referer), a UA."""
    no_referer = any(c.get("type") == "header" and c.get("key") == "referer" and c.get("op") == "nex" for c in group)
    network = any(c.get("type") in ("geo_as_number", "ip_address") and not c.get("neg") for c in group)
    google = any(c.get("type") == "user_agent" and not c.get("neg") and "google" in str(c.get("value")).lower() for c in group)
    exact_uas = any(c.get("type") == "user_agent" and c.get("op") == "inc" and not c.get("neg") for c in group)
    return "challenge" if no_referer and not network and not google and not exact_uas else "deny"


def place(firewall: dict, groups: list[list[dict]], label: str, today: str) -> dict:
    """A copy of firewall with each group added to the rule its verdict names; adds scraper-challenge after scraper-blocklist if missing."""
    out = json.loads(json.dumps(firewall))
    names = [r["name"] for r in out["rules"]]
    if RULES["challenge"] not in names and any(verdict(g) == "challenge" for g in groups):
        out["rules"].insert(names.index(RULES["deny"]) + 1, json.loads(json.dumps(CHALLENGE_RULE)))
    for group in groups:
        rule = next(r for r in out["rules"] if r["name"] == RULES[verdict(group)])
        rule["groups"].append({"label": label, "added": today, "conditions": group})
    return out


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
    print(json.dumps([{"rule": RULES[verdict(g)], "conditions": g} for g in groups], indent=1))
    if a.dry_run:
        return
    os.environ["FIREWALL_OWN_UA"] = own_ua()
    stale = drift(run("node", "scripts/repo/vercel/firewall.mjs", "diff"))
    if stale:
        sys.exit("\n".join(stale) + f"\nThe checkout's {FILE} differs from the live config, so take in staging (or commit the live state) first.")
    path = os.path.join(REPO, FILE)
    today = datetime.datetime.now(datetime.UTC).date().isoformat()
    firewall = place(json.load(open(path)), groups, a.label, today)
    with open(path, "w") as f:
        f.write(json.dumps(firewall, indent="\t", ensure_ascii=False) + "\n")
    run("node", "scripts/repo/vercel/firewall.mjs", "apply")
    run("node", "scripts/repo/agent/commit.mjs", "-m", f"chore(search): the firewall {'blocks' if any(verdict(g) == 'deny' for g in groups) else 'challenges'} {a.label}", FILE)


if __name__ == "__main__":
    main()

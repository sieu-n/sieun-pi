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
      [--public-only] [--forged-referer [--client-ips 1.2.3.4 ...]] [--dry-run]
  python3 legacy/prime/user-history/scripts/duties/scraper-block.py --label "<who, date>" --groups-file <file.json> [--dry-run]
A group needs a UA or a network (asn, cidr or ip). A group with no UA condition skips the allow list (search indexing bots and
link previews, "$allow_ua"), every group skips our own boxes, and --public-only limits it to the public data pages and their
APIs ("$public_data"). --groups-file takes {"groups": [{"conditions": [...]}]} in the file's condition shape, for header,
query or cookie conditions. --dry-run prints the group and changes nothing.
--forged-referer takes a client whose page loads each carry a virev.ai referer while it loads no __data.json and no /api, the weekly
precheck's forged-referer reason. Its group matches the UA alone (--ua-sub as an exact UA, or --ua-re), on every path and any referer, as
auto-sns-agent d5c39145ee's Windows Chrome 152.0.0.0 group, because a forged referer skips every no-referer group: on 11-15 that client made
22,176 such page loads from 7 home IPs. It goes to scraper-challenge, since people share the UA, and to scraper-blocklist only with --asn, which the caller passes only for a
hosting network, as the precheck's command passes only the ASNs that ip-asn.ts isHosting names.
A UA that real visitors use is never challenged alone: the script counts the IPs that sent that UA with a browser sign (an /api call,
__data.json or a /_ asset) in the drain's last 7 days, and at COMMON_UA_SIGN_IPS or more it blocks the client by its IPs (--client-ips, which
the precheck prints): the ones on Tor's published exit list (TOR_EXITS) are denied with the UA, and the rest challenged with the UA. With no
--client-ips it refuses. On 11-15 a client on 12 Tor exits sent Windows Chrome/154.0.0.0, which 361 IPs sent with a browser sign that week.
A denied request shows in the Vercel drain (prod ClickHouse otel.otel_logs, service search) with
LogAttributes['vercel.source'] = 'firewall' and LogAttributes['vercel.proxy.wafRule'] = 'rule_scraper_blocklist_5OLTML';
a blocked client has no 'lambda' rows after the publish.
"""
import argparse, datetime, json, os, subprocess, sys, urllib.request

REPO = "/home/sieun/Documents/Github/auto-sns-agent"
FILE = "apps/search/firewall.json"
RULES = {"deny": "scraper-blocklist", "challenge": "scraper-challenge"}
TOR_EXITS = "https://check.torproject.org/torbulkexitlist"
# measured: in the 7 days to 11-15 18:30Z the forged-referer UAs had 0 to 39 IPs with a browser sign (Chrome/152.0.0.0, 39, which d5c39145ee
# challenges alone), while the common ones under which Tor exits and a /blog client hid had 361 (Windows Chrome/154.0.0.0) and 3,213 (Mac Chrome/146.0.0.0).
COMMON_UA_SIGN_IPS = 100
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


def ua_condition(a: argparse.Namespace) -> dict:
    return {"type": "user_agent", "op": "eq", "value": a.ua_sub} if a.ua_sub else {"type": "user_agent", "op": "re", "value": a.ua_re}


def forged_groups(a: argparse.Namespace, sign_ips: int, tor_exits: frozenset[str]) -> list[tuple[str, list[dict]]]:
    """The (verdict, group) pairs for a forged-referer client: deny by UA and hosting ASN; challenge by the UA alone while fewer than
    COMMON_UA_SIGN_IPS IPs sent it with a browser sign; else deny by UA and its Tor exit IPs and challenge by UA and its other IPs."""
    ua, own = ua_condition(a), {"use": "skip_own_ips"}
    if a.asn:
        return [("deny", [ua, net("geo_as_number", a.asn), own])]
    if sign_ips < COMMON_UA_SIGN_IPS:
        return [("challenge", [ua, own])]
    if not a.client_ips:
        sys.exit(f"{sign_ips} IPs sent this UA with a browser sign in 7 days, so a UA-only group would challenge real visitors; pass --client-ips")
    tor = [ip for ip in a.client_ips if ip in tor_exits]
    home = [ip for ip in a.client_ips if ip not in tor_exits]
    return [(kind, [ua, net("ip_address", ips), own]) for kind, ips in (("deny", tor), ("challenge", home)) if ips]


def ua_sign_ips(a: argparse.Namespace) -> int:
    """The IPs that sent the UA with a browser sign on prod virev.ai in the last 7 days, from the drain through ops/bin/ch-ro."""
    ua = r"""replaceRegexpAll(LogAttributes['vercel.proxy.userAgent'], '^\\["|"\\]$', '')"""
    path = "LogAttributes['vercel.proxy.path']"
    value = "'" + (a.ua_sub or a.ua_re).replace("\\", "\\\\").replace("'", "\\'") + "'"
    match = f"{ua} = {value}" if a.ua_sub else f"match({ua}, {value})"
    sign = f"position({path}, '/api/') > 0 OR position({path}, '__data.json') > 0 OR startsWith({path}, '/_')"
    sql = (f"SELECT uniqExactIf(LogAttributes['vercel.proxy.clientIp'], {sign}) FROM otel.otel_logs WHERE ServiceName = 'search' "
        f"AND `__hdx_materialized_deployment.environment.name` = 'production' AND Timestamp > now() - INTERVAL 7 DAY AND {match} "
        "SETTINGS max_threads = 2 FORMAT TSV")
    out = subprocess.run(["ops/bin/ch-ro", "-q", sql], cwd=REPO, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"the browser-sign read of the UA failed: {out.stderr.strip()[-400:]}")
    return int(out.stdout.strip())


def tor_exits() -> frozenset[str]:
    with urllib.request.urlopen(TOR_EXITS) as body:
        return frozenset(body.read().decode().split())


def verdict(group: list[dict]) -> str:
    """challenge for a no-referer group with no network, no Google UA and a UA regex or substring (a home-proxy fleet a person's direct visit
    can also match, 11-15), deny for the rest: a hosting ASN or IP list, a fake Googlebot from outside Google's network, a bare Google referer
    (the X11 fleet), an exact UA list copied from one fleet's requests (of the 11-03 group's 32,764 denied IP and UA pairs from 11-08 to 11-15,
    0 opened a page with a virev.ai referer), a UA. forged_groups decides a forged-referer client's groups instead."""
    network = any(c.get("type") in ("geo_as_number", "ip_address") and not c.get("neg") for c in group)
    no_referer = any(c.get("type") == "header" and c.get("key") == "referer" and c.get("op") == "nex" for c in group)
    google = any(c.get("type") == "user_agent" and not c.get("neg") and "google" in str(c.get("value")).lower() for c in group)
    exact_uas = any(c.get("type") == "user_agent" and c.get("op") == "inc" and not c.get("neg") for c in group)
    return "challenge" if no_referer and not network and not google and not exact_uas else "deny"


def place(firewall: dict, placed: list[tuple[str, list[dict]]], label: str, today: str) -> dict:
    """A copy of firewall with each (verdict, group) added to the rule its verdict names; adds scraper-challenge after scraper-blocklist if missing."""
    out = json.loads(json.dumps(firewall))
    names = [r["name"] for r in out["rules"]]
    if RULES["challenge"] not in names and any(kind == "challenge" for kind, _ in placed):
        out["rules"].insert(names.index(RULES["deny"]) + 1, json.loads(json.dumps(CHALLENGE_RULE)))
    for kind, group in placed:
        rule = next(r for r in out["rules"] if r["name"] == RULES[kind])
        rule["groups"].append({"label": label, "added": today, "conditions": group})
    return out


def args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--ua-sub")
    ap.add_argument("--ua-re")
    ap.add_argument("--asn", nargs="*", default=[])
    ap.add_argument("--cidr", nargs="*", default=[])
    ap.add_argument("--ip", nargs="*", default=[])
    ap.add_argument("--public-only", action="store_true")
    ap.add_argument("--forged-referer", action="store_true")
    ap.add_argument("--client-ips", nargs="*", default=[])
    ap.add_argument("--groups-file")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.forged_referer and not a.groups_file and (a.public_only or not (a.ua_sub or a.ua_re)):
        ap.error("--forged-referer takes --ua-sub or --ua-re and covers every path, so it takes no --public-only")
    if a.forged_referer and (a.ip or a.cidr):
        ap.error("--forged-referer takes the client's IPs as --client-ips and decides itself whether to use them")
    return a


def main() -> None:
    a = args()
    if a.groups_file:
        placed = [(verdict(g["conditions"]), g["conditions"]) for g in json.load(open(a.groups_file))["groups"]]
    elif a.forged_referer:
        sign_ips = 0 if a.asn else ua_sign_ips(a)
        print(f"{sign_ips} IPs sent this UA with a browser sign in the last 7 days")
        exits = tor_exits() if sign_ips >= COMMON_UA_SIGN_IPS and a.client_ips and not a.asn else frozenset()
        placed = forged_groups(a, sign_ips, exits)
    elif a.ua_sub or a.ua_re or a.asn or a.cidr or a.ip:
        group = flag_group(a)
        placed = [(verdict(group), group)]
    else:
        sys.exit("a group needs a UA or a network, or pass --groups-file")
    print(json.dumps([{"rule": RULES[kind], "conditions": g} for kind, g in placed], indent=1))
    if a.dry_run:
        return
    os.environ["FIREWALL_OWN_UA"] = own_ua()
    stale = drift(run("node", "scripts/repo/vercel/firewall.mjs", "diff"))
    if stale:
        sys.exit("\n".join(stale) + f"\nThe checkout's {FILE} differs from the live config, so take in staging (or commit the live state) first.")
    path = os.path.join(REPO, FILE)
    today = datetime.datetime.now(datetime.UTC).date().isoformat()
    firewall = place(json.load(open(path)), placed, a.label, today)
    with open(path, "w") as f:
        f.write(json.dumps(firewall, indent="\t", ensure_ascii=False) + "\n")
    run("node", "scripts/repo/vercel/firewall.mjs", "apply")
    run("node", "scripts/repo/agent/commit.mjs", "-m", f"chore(search): the firewall {'blocks' if any(kind == 'deny' for kind, _ in placed) else 'challenges'} {a.label}", FILE)


if __name__ == "__main__":
    main()

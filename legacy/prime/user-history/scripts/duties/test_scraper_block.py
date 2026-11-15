"""scraper-block.py puts a no-referer home-proxy fleet in scraper-challenge and keeps hosting ASNs and fake Google fleets in scraper-blocklist (11-15)."""
import importlib.util
import os
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("scraper_block", os.environ.get("SCRAPER_BLOCK_PY", Path(__file__).with_name("scraper-block.py")))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

PUBLIC = {"type": "path", "op": "re", "value": "$public_data"}
NO_REFERER = {"type": "header", "key": "referer", "op": "nex"}
OWN = {"use": "skip_own_ips"}
HOME_FLEET = [PUBLIC, {"type": "user_agent", "op": "sub", "value": "X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"}, NO_REFERER, OWN]
HOSTING = [PUBLIC, {"type": "geo_as_number", "op": "inc", "value": ["203020", "57043"]}, {"type": "user_agent", "op": "re", "neg": True, "value": "$allow_ua"}, OWN]
FAKE_GOOGLEBOT = [{"type": "user_agent", "op": "re", "value": "Googlebot|Google-InspectionTool"}, {"type": "geo_as_number", "op": "eq", "neg": True, "value": "15169"}, OWN]
X11_FAKE_GOOGLE = [{"type": "user_agent", "op": "re", "value": "^Mozilla/5\\.0 \\(X11; Linux x86_64\\)"}, {"type": "header", "key": "referer", "op": "re", "value": "^https://www\\.google\\.[a-z.]+/$"}, OWN]
HOSTING_NO_REFERER = [PUBLIC, {"type": "geo_as_number", "op": "eq", "value": "14061"}, NO_REFERER, OWN]
# scraper-blocklist's "weekly d7 run 11-03" group of 21 no-referer Mac and Windows Chrome and Mac Firefox fleets, as apps/search/firewall.json holds it.
EXACT_UA_FLEET = [PUBLIC, {"type": "user_agent", "op": "inc", "value": [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
]}, NO_REFERER, OWN]


def firewall(*rules: str) -> dict:
    return {"rules": [{"name": name, "action": {"action": "deny"}, "groups": []} for name in rules]}


class Placement(unittest.TestCase):
    def test_home_fleet_goes_to_challenge_and_proven_fakes_stay_deny(self):
        groups = [HOME_FLEET, HOSTING, FAKE_GOOGLEBOT, X11_FAKE_GOOGLE, HOSTING_NO_REFERER]
        out = sb.place(firewall("public-db-bot-ua", "scraper-blocklist"), groups, "weekly", "2026-11-15")
        rules = {r["name"]: r for r in out["rules"]}
        self.assertEqual([r["name"] for r in out["rules"]], ["public-db-bot-ua", "scraper-blocklist", "scraper-challenge"])
        self.assertEqual(rules["scraper-challenge"]["action"], {"action": "challenge"})
        self.assertEqual([g["conditions"] for g in rules["scraper-challenge"]["groups"]], [HOME_FLEET])
        self.assertEqual([g["conditions"] for g in rules["scraper-blocklist"]["groups"]], [HOSTING, FAKE_GOOGLEBOT, X11_FAKE_GOOGLE, HOSTING_NO_REFERER])

    def test_existing_challenge_rule_takes_the_group(self):
        out = sb.place(firewall("scraper-blocklist", "scraper-challenge"), [HOME_FLEET], "weekly", "2026-11-15")
        self.assertEqual(len(out["rules"]), 2)
        self.assertEqual(out["rules"][1]["groups"], [{"label": "weekly", "added": "2026-11-15", "conditions": HOME_FLEET}])

    def test_exact_ua_list_with_no_referer_stays_deny(self):
        """11-15: the 11-03 fleet list stays deny, 0 of its 32,764 denied pairs from 11-08 to 11-15 opened a page with a virev.ai referer."""
        self.assertEqual(sb.verdict(EXACT_UA_FLEET), "deny")
        self.assertEqual(sb.verdict(HOME_FLEET), "challenge")


CHROME_152 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
# The group auto-sns-agent d5c39145ee added to scraper-challenge for the 11-15 forged-referer client.
D5C39145EE = [{"type": "user_agent", "op": "eq", "value": CHROME_152}, OWN]


class ForgedReferer(unittest.TestCase):
    def test_forged_referer_client_is_challenged_by_its_ua_and_denied_only_on_a_hosting_network(self):
        """11-15: the Chrome 152.0.0.0 client sent a virev.ai referer on 22,176 page loads, so every no-referer group skipped it."""
        home = sb.flag_group(sb.args(["--label", "x", "--forged-referer", "--ua-sub", CHROME_152]))
        self.assertEqual(home, D5C39145EE)
        hosting = sb.flag_group(sb.args(["--label", "x", "--forged-referer", "--ua-sub", CHROME_152, "--asn", "14061"]))
        out = sb.place(firewall("scraper-blocklist", "scraper-challenge"), [home, hosting], "weekly", "2026-11-15", forged_referer=True)
        self.assertEqual([[g["conditions"] for g in r["groups"]] for r in out["rules"]], [[hosting], [home]])


class Drift(unittest.TestCase):
    def test_a_file_that_differs_from_live_is_refused(self):
        """11-15: dev/sieun's firewall.json predated staging 6df678ce83, so an apply would have reverted the live rules."""
        stale = "same      public-db-bot-ua\nreplace   scraper-blocklist\nunmanaged scraper-challenge (live, not in the file, left alone)\nno changes\n"
        self.assertEqual(sb.drift(stale), ["replace   scraper-blocklist", "unmanaged scraper-challenge (live, not in the file, left alone)"])
        self.assertEqual(sb.drift("same      public-db-bot-ua\nsame      scraper-blocklist\nno changes\n"), [])


if __name__ == "__main__":
    unittest.main()

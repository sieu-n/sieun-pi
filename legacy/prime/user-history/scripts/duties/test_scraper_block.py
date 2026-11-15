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


if __name__ == "__main__":
    unittest.main()

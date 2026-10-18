import json
from pathlib import Path
import subprocess
import unittest

EXTENSION = Path(__file__).resolve().parent.parent / "app" / "extension" / "index.ts"


def pool_bin(here):
    script = f"import {{ poolBin }} from {json.dumps(EXTENSION.as_uri())}; console.log(poolBin({json.dumps(here)}));"
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    return result.stdout.strip().splitlines()[-1]


class PoolBin(unittest.TestCase):
    def test_installed_release_calls_current_cli(self):
        # 10-14 12:06:26 KST: a session on release 6601cc2bbdfd ran that release's
        # owner-turn after 00a7feba9b52 was current, so its owner admit waited 175.8 s.
        self.assertEqual(pool_bin("/h/.local/share/pi-pool/releases/6601cc2bbdfd/app/extension"),
                         "/h/.local/share/pi-pool/current/bin/pi-pool-token")

    def test_checkout_calls_its_own_cli(self):
        self.assertEqual(pool_bin("/h/sieun-pi/components/pi-pool/app/extension"),
                         "/h/sieun-pi/components/pi-pool/bin/pi-pool-token")

    def test_install_staging_calls_its_own_cli(self):
        # 10-16 02:55Z and 04:05Z: the install of 71316c0 ran its extension tests in releases/.staging-*, which called the live release's
        # CLI with the memory governor on, so a child's borrow was refused and the install stopped.
        self.assertEqual(pool_bin("/h/.local/share/pi-pool/releases/.staging-8e25ad526b0a-75370/app/extension"),
                         "/h/.local/share/pi-pool/releases/.staging-8e25ad526b0a-75370/bin/pi-pool-token")

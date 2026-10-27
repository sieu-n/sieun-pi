import os
import subprocess
from pathlib import Path
import unittest

from fixture_isolation import isolate_test_module
from prime_extension import EXTENSION


def setUpModule():
    isolate_test_module()


class ExtensionSelection(unittest.TestCase):
    def test_selection_controls_and_retry_semantics(self):
        driver = Path(__file__).resolve().with_name("selection_driver.mjs")
        result = subprocess.run(["node", "--test", str(driver)], capture_output=True, text=True,
                                env=dict(os.environ, PI_POOL_EXTENSION=str(EXTENSION)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

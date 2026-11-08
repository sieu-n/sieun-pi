import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
SYNC = REPO / "components/prime-sync/sync.py"


class PrimeSyncBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_the_checkout_bundle_follows_its_source_when_prime_loads_the_extension_from_the_checkout(self):
        # p1485 follow-up, 11-08: us-metal02 workers loaded user-history from 73 source files, 0.42 CPU-s a start warm and 7.7 cold.
        spec = importlib.util.spec_from_file_location("prime_sync_bundle", SYNC)
        sync = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sync)
        checkout, agent = self.root / "checkout", self.root / "agent"
        component = checkout / sync.EXTENSION
        (component / "extension").mkdir(parents=True)
        (component / "src").mkdir()
        (agent / "extensions").mkdir(parents=True)
        (component / "extension/index.ts").write_text('import { word } from "../src/word.ts";\nexport default (): string => word;\n')
        (component / "src/word.ts").write_text('export const word: string = "one";\n')
        for name in ("extension-bundle.ts", "build-extension-bundle.ts"):
            shutil.copy(REPO / sync.EXTENSION / "src" / name, component / "src" / name)
        (component / "node_modules").symlink_to(REPO / sync.EXTENSION / "node_modules")
        self.assertEqual(sync.build_bundle(checkout, agent), "", "no link into the checkout, so nothing to build")
        (agent / "extensions/user-history").symlink_to(component)
        self.assertRegex(sync.build_bundle(checkout, agent), r"^built src/extension\.[0-9a-f]{16}\.bundle\.mjs from 2 inputs$")
        self.assertEqual(sync.build_bundle(checkout, agent), "")
        (component / "src/word.ts").write_text('export const word: string = "two";\n')
        built = sync.build_bundle(checkout, agent)
        self.assertTrue(built.startswith("built "), built)
        self.assertIn('"two"', (component / built.split()[1]).read_text())
        (component / "src/word.ts").write_text("export const word: string = ;\n")
        self.assertIn("not built (exit 1)", sync.build_bundle(checkout, agent))


if __name__ == "__main__":
    unittest.main()

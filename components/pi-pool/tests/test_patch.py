import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("patch_prime_agent", ROOT / "app/patch_prime_agent.py")
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class PatchStagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.bundle = self.root / "dist/bundle"
        self.bundle.mkdir(parents=True)
        (self.root / "package.json").write_text('{"version":"fixture"}')
        self.targets = [
            {"id": name, "needle": "// " + name, "helper": False,
             "patches": [(name, "const value = 1;", "const value = 2; /* pi-pool */")]}
            for name in ["exporter", "importer"]
        ]
        self.originals = {}
        for target in self.targets:
            path = self.bundle / (target["id"] + ".js")
            text = "// " + target["id"] + "\nconst value = 1;\n"
            path.write_text(text)
            self.originals[path] = text
        for name, value in {"TARGETS": self.targets, "LOG": str(self.root / "log"),
                            "POOL_DIR": str(self.root / "pool"),
                            "package_root": lambda: str(self.root),
                            "agent_dir": lambda: str(self.root / "agent")}.items():
            mock = patch.object(patcher, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def assertOriginals(self):
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text)

    def test_missing_later_anchor_writes_nothing(self):
        self.targets[1]["patches"][0] = ("missing", "not present", "replacement")
        with self.assertRaises(SystemExit):
            patcher.apply()
        self.assertOriginals()

    def test_duplicate_later_anchor_writes_nothing(self):
        path = self.bundle / "importer.js"
        path.write_text(path.read_text() + "const value = 1;\n")
        self.originals[path] = path.read_text()
        with self.assertRaises(SystemExit):
            patcher.apply()
        self.assertOriginals()

    def test_invalid_later_output_writes_nothing(self):
        self.targets[1]["patches"][0] = ("syntax", "const value = 1;", "const = ; /* pi-pool */")
        with self.assertRaises(SystemExit):
            patcher.apply()
        self.assertOriginals()

    def test_round_trip_and_double_apply(self):
        patcher.apply()
        applied = {path: path.read_bytes() for path in self.originals}
        patcher.apply()
        self.assertEqual(patcher.check(quiet=True), 0)
        for path, data in applied.items():
            self.assertEqual(path.read_bytes(), data)
        patcher.revert()
        self.assertOriginals()

    def test_session_width_patch_round_trip_and_upgrade(self):
        entry = next(entry for entry in patcher.TUI_PATCHES
                     if entry[0] == "agents-session-width")
        self.assertNotIn(entry[0], [item[0] for item in patcher.LEGACY_TUI_PATCHES])
        path = self.bundle / "exporter.js"
        original = self.originals[path] + (
            "function layout(width, available, desiredModelWidth) {\n" + entry[1]
            + "  return { nameWidth, modelWidth };\n}\n")
        self.originals[path] = original
        path.write_text(original)
        patcher.apply(bundle_only=True)
        backup = pathlib.Path(str(path) + ".bak-pi-pool")
        self.assertEqual(backup.read_text(), original)
        self.targets[0]["patches"].append(entry)
        self.assertEqual(patcher.check(quiet=True, bundle_only=True), 1)
        patcher.apply(bundle_only=True)
        applied = path.read_bytes()
        self.assertIn(entry[2], path.read_text())
        self.assertEqual(patcher._original_source(path.read_text(), self.targets[0]), original)
        self.assertEqual(backup.read_text(), original)
        patcher.apply(bundle_only=True)
        self.assertEqual(path.read_bytes(), applied)
        self.assertEqual(patcher.check(quiet=True, bundle_only=True), 0)
        patcher.revert(bundle_only=True)
        self.assertOriginals()

    def test_unknown_backup_refuses_without_writing(self):
        path = self.bundle / "exporter.js"
        pathlib.Path(str(path) + ".bak-pi-pool").write_text("// wrong version\n")
        with self.assertRaises(SystemExit):
            patcher.apply()
        self.assertOriginals()

    def test_old_patch_set_upgrades_without_replacing_backup(self):
        for target in self.targets:
            path = self.bundle / (target["id"] + ".js")
            old = "const value = 0; /* pi-pool */"
            target["legacy_patches"] = [("old", "const value = 1;", old)]
            path.write_text(self.originals[path].replace("const value = 1;", old))
            pathlib.Path(str(path) + ".bak-pi-pool").write_text(self.originals[path])
        patcher.apply()
        for path, original in self.originals.items():
            self.assertEqual(pathlib.Path(str(path) + ".bak-pi-pool").read_text(), original)
        patcher.revert()
        self.assertOriginals()

    def test_interrupted_apply_converges_in_dependency_order(self):
        replace = patcher.os.replace
        written = []
        def fail_importer(source, destination):
            if destination.endswith(".js"):
                written.append(pathlib.Path(destination).stem)
                if destination.endswith("importer.js"):
                    raise OSError("synthetic interrupted write")
            return replace(source, destination)
        with patch.object(patcher.os, "replace", fail_importer):
            with self.assertRaises(OSError):
                patcher.apply()
        self.assertEqual(written, ["exporter", "importer"])
        patcher.apply()
        self.assertEqual(patcher.check(quiet=True), 0)
        written.clear()
        def record(source, destination):
            if destination.endswith(".js"):
                written.append(pathlib.Path(destination).stem)
            return replace(source, destination)
        with patch.object(patcher.os, "replace", record):
            patcher.revert()
        self.assertEqual(written, ["importer", "exporter"])
        self.assertOriginals()

    def test_check_refuses_unknown_backup(self):
        patcher.apply()
        path = self.bundle / "exporter.js"
        pathlib.Path(str(path) + ".bak-pi-pool").write_text("// unknown\n")
        self.assertEqual(patcher.check(quiet=True), 2)

    def test_interrupted_revert_converges(self):
        patcher.apply()
        replace = patcher.os.replace
        def fail_exporter(source, destination):
            if destination.endswith("exporter.js"):
                raise OSError("synthetic interrupted revert")
            return replace(source, destination)
        with patch.object(patcher.os, "replace", fail_exporter):
            with self.assertRaises(OSError):
                patcher.revert()
        patcher.revert()
        self.assertOriginals()

    def test_invalid_helper_stages_before_any_write(self):
        self.targets[0]["helper"] = True
        helper = self.root / "helper.js"
        helper.write_text("export const = ;")
        with patch.object(patcher, "HELPER_SRC", str(helper)):
            with self.assertRaises(SystemExit):
                patcher.apply()
        self.assertOriginals()
        self.assertFalse(list(self.bundle.glob("*.bak-pi-pool")))

    def test_apply_updates_helper_when_bundle_is_already_patched(self):
        self.targets[0]["helper"] = True
        helper = self.root / "helper.js"
        helper.write_text("export const fixture = 1;\n")
        destination = self.bundle / patcher.HELPER_NAME
        with patch.object(patcher, "HELPER_SRC", str(helper)):
            patcher.apply()
            bundles = {path: path.read_bytes() for path in self.originals}
            backups = {path: pathlib.Path(str(path) + ".bak-pi-pool").read_bytes()
                       for path in self.originals}
            helper.write_text("export const fixture = 2;\n")
            self.assertEqual(patcher.check(quiet=True), 1)
            patcher.apply()
            self.assertEqual(destination.read_bytes(), helper.read_bytes())
            self.assertEqual(patcher.check(quiet=True), 0)
            for path in self.originals:
                self.assertEqual(path.read_bytes(), bundles[path])
                self.assertEqual(pathlib.Path(str(path) + ".bak-pi-pool").read_bytes(), backups[path])
            helper.write_text("export const = ;")
            with self.assertRaises(SystemExit):
                patcher.apply()
            self.assertEqual(destination.read_text(), "export const fixture = 2;\n")

    def test_source_scan_ignores_backups_and_nested_state(self):
        needle = self.targets[0]["needle"]
        (self.bundle / "exporter.js.bak-pi-pool").write_text(needle)
        state = self.bundle / "backups"
        state.mkdir()
        (state / "exporter.js").write_text(needle)
        self.assertEqual(patcher.find_chunk(str(self.bundle), needle),
                         [str(self.bundle / "exporter.js")])

    def test_bundle_only_apply_check_and_revert_never_access_extension(self):
        with patch.object(patcher, "extension_state", side_effect=AssertionError("extension read")), \
             patch.object(patcher, "ensure_extension_link", side_effect=AssertionError("extension write")), \
             patch.object(patcher, "remove_extension_link", side_effect=AssertionError("extension removal")), \
             patch.object(patcher, "agent_dir", side_effect=AssertionError("agent directory read")):
            self.assertEqual(patcher.main(["apply", "--bundle-only"]), 0)
            self.assertEqual(patcher.main(["--check", "--bundle-only"]), 0)
            self.assertEqual(patcher.main(["unpatch", "--bundle-only"]), 0)
        self.assertOriginals()

    def test_normal_check_still_requires_extension(self):
        patcher.apply(bundle_only=True)
        self.assertEqual(patcher.check(quiet=True, bundle_only=True), 0)
        self.assertEqual(patcher.check(quiet=True), 1)
        patcher.apply()
        self.assertEqual(patcher.check(quiet=True), 0)

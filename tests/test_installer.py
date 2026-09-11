import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sieun-pi-installer-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.checkout = self.base / "checkout"
        self.home = self.base / "home"
        self.project = self.base / "project"
        self.home.mkdir()
        self.project.mkdir()
        (self.checkout / "scripts").mkdir(parents=True)
        shutil.copyfile(REPO / "scripts/manage.py", self.checkout / "scripts/manage.py")
        shutil.copyfile(REPO / "install-manifest.json", self.checkout / "install-manifest.json")
        manifest = json.loads((self.checkout / "install-manifest.json").read_text())
        for entry in manifest["entries"]:
            if "source" not in entry:
                continue
            source = self.checkout / entry["source"]
            if (REPO / entry["source"]).is_dir():
                source.mkdir(parents=True, exist_ok=True)
                (source / "source.txt").write_text(entry["id"])
            else:
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("{}\n" if source.suffix == ".json" else entry["id"] + "\n")
        spec = importlib.util.spec_from_file_location("fixture_installer", self.checkout / "scripts/manage.py")
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def plan(self, project=True):
        return self.installer.make_plan(self.home, self.project if project else None)

    def operation(self, plan, name):
        return next(operation for operation in plan["operations"] if operation["id"] == name)

    def write_home(self, relative, content):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def cli(self, *args):
        env = {**os.environ, "HOME": str(self.home), "PI_POOL_DIR": str(self.home / ".config/pi-pool"),
               "PRIME_AGENT_CODING_AGENT_DIR": str(self.home / ".prime/agent")}
        return subprocess.run([sys.executable, "-B", str(self.checkout / "scripts/manage.py"), *args],
                              env=env, text=True, capture_output=True)

    def test_fresh_home_and_project(self):
        plan = self.plan()
        receipt = self.installer.apply_plan(plan)
        self.assertTrue(receipt.is_relative_to(self.home / ".local/state/sieun-pi"))
        self.assertFalse(receipt.is_relative_to(self.checkout))
        self.assertEqual(self.installer.verify(self.home, self.project)["verified"], 67)
        settings = self.home / ".prime/agent/settings.json"
        self.assertFalse(settings.is_symlink())
        self.assertEqual(json.loads(settings.read_text()), {})
        self.assertFalse((self.home / ".prime/agent").is_symlink())
        self.assertFalse((self.home / ".config/pi-pool").is_symlink())
        projects = self.home / ".prime/agent/virev-projects.json"
        self.assertEqual(json.loads(projects.read_text()), {"projects": [{"root": str(self.project), "policy": "auto-sns-agent"}]})
        self.assertFalse((self.project / ".prime").exists())
        self.assertTrue((self.home / ".prime/agent/extensions/virev.ts").is_symlink())
        self.assertTrue((self.home / ".prime/agent/extensions/user-history").is_symlink())

    def test_apply_twice_and_new_plan_converge(self):
        plan = self.plan()
        receipt = self.installer.apply_plan(plan)
        original = receipt.read_bytes()
        self.assertEqual(self.installer.apply_plan(plan), receipt)
        self.assertEqual(receipt.read_bytes(), original)
        next_plan = self.plan()
        self.assertTrue(all(operation["before"] == operation["after"] for operation in next_plan["operations"]))
        next_receipt = self.installer.apply_plan(next_plan)
        self.assertEqual(list((next_receipt.parent / "backups").iterdir()), [])

    def test_preserves_runtime_and_existing_settings_bytes(self):
        sentinels = {
            ".prime/agent/auth.json": b'{"synthetic-auth":"never-export-this-fixture"}\n',
            ".prime/agent/models.json": b'{"fixture":true}\n',
            ".prime/agent/settings.json": b'{ "extensions": [], "custom": "keep-spacing" }\n',
            ".prime/agent/sessions/sentinel": b"session fixture\x00",
            ".prime/agent/memories/sentinel": b"memory fixture\x01",
            ".config/pi-pool/.git/config": b"repository fixture\n",
            ".config/pi-pool/state.json": b"pool runtime fixture\n",
        }
        paths = {self.write_home(name, content): content for name, content in sentinels.items()}
        receipt = self.installer.apply_plan(self.plan())
        for path, content in paths.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertNotIn(b"never-export-this-fixture", receipt.read_bytes())
        self.assertNotIn(b"keep-spacing", receipt.read_bytes())
        self.installer.rollback_receipt(receipt)
        for path, content in paths.items():
            self.assertEqual(path.read_bytes(), content)

    def test_source_drift_rejected_before_mutation(self):
        plan = self.plan()
        source = Path(self.operation(plan, "agent-rules")["source"])
        source.write_text("changed source\n")
        with self.assertRaisesRegex(self.installer.InstallError, "Source or plan changed"):
            self.installer.apply_plan(plan)
        self.assertFalse((self.home / ".prime").exists())
        self.assertFalse((self.home / ".local/state").exists())

    def test_destination_drift_rejected_before_any_link(self):
        plan = self.plan()
        target = self.project / ".prime/agent/virev-project.json"
        target.parent.mkdir(parents=True)
        target.write_text("changed destination\n")
        with self.assertRaisesRegex(self.installer.InstallError, "Destination changed"):
            self.installer.apply_plan(plan)
        self.assertFalse((self.home / ".prime").exists())

    def test_unsafe_parent_rejected_during_plan_and_apply(self):
        plan = self.plan()
        outside = self.base / "outside"
        outside.mkdir()
        (self.home / ".prime").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(self.installer.InstallError, "Unsafe symlink"):
            self.plan()
        with self.assertRaisesRegex(self.installer.InstallError, "Unsafe symlink"):
            self.installer.apply_plan(plan)
        self.assertEqual(list(outside.iterdir()), [])

    def test_source_symlinks_are_rejected(self):
        source = self.checkout / "skills/unslop/source.txt"
        source.unlink()
        source.symlink_to(self.base / "external-source")
        with self.assertRaisesRegex(self.installer.InstallError, "Source symlinks"):
            self.plan()

    def test_protected_child_is_rejected_without_export(self):
        self.write_home(".prime/agent/skills/unslop/auth.json", b"synthetic forbidden fixture")
        with self.assertRaisesRegex(self.installer.InstallError, "Protected path"):
            self.plan()
        self.assertFalse((self.home / ".local/state").exists())

    def test_existing_source_directory_and_link_restore(self):
        old = self.write_home(".prime/agent/skills/unslop/old.txt", b"old source\n")
        rules = self.home / ".prime/agent/AGENTS.md"
        rules.symlink_to(self.base / "previous-rules.md")
        receipt = self.installer.apply_plan(self.plan())
        backup_contents = [path.read_bytes() for path in (receipt.parent / "backups").rglob("old.txt")]
        self.assertEqual(backup_contents, [b"old source\n"])
        self.assertTrue(old.parent.is_symlink())
        self.installer.rollback_receipt(receipt)
        self.assertFalse(old.parent.is_symlink())
        self.assertEqual(old.read_bytes(), b"old source\n")
        self.assertEqual(os.readlink(rules), str(self.base / "previous-rules.md"))
        self.installer.rollback_receipt(receipt)

    def test_interrupted_apply_after_backup_resumes(self):
        self.write_home(".prime/agent/skills/architect/old.txt", b"old source")
        plan = self.plan()
        with patch.object(self.installer, "publish", side_effect=InterruptedError("test interruption")):
            with self.assertRaises(InterruptedError):
                self.installer.apply_plan(plan)
        receipt = self.installer.receipt_location(self.home, plan["id"])
        saved = json.loads(receipt.read_text())
        self.assertEqual(saved["changes"][0]["state"], "prepared")
        self.assertTrue((receipt.parent / "backups/0/old.txt").exists())
        self.installer.apply_plan(plan)
        self.assertEqual(self.installer.verify(self.home, self.project)["verified"], 67)
        self.installer.rollback_receipt(receipt)
        self.assertEqual((self.home / ".prime/agent/skills/architect/old.txt").read_bytes(), b"old source")

    def test_interrupted_apply_after_publish_resumes(self):
        plan = self.plan()
        publish = self.installer.publish

        def interrupt(operation, plan_id):
            publish(operation, plan_id)
            raise InterruptedError("after publication")

        with patch.object(self.installer, "publish", side_effect=interrupt):
            with self.assertRaises(InterruptedError):
                self.installer.apply_plan(plan)
        receipt = self.installer.apply_plan(plan)
        self.assertEqual(json.loads(receipt.read_text())["state"], "applied")

    def test_interrupted_generated_json_write_resumes(self):
        plan = self.plan()
        publish = self.installer.publish

        def interrupt(operation, plan_id):
            if operation["kind"] == "generated-json":
                temporary = self.installer.generated_temporary(operation, plan_id)
                temporary.write_bytes(self.installer.json_bytes(operation["value"])[:1])
                temporary.chmod(0o600)
                raise InterruptedError("partial JSON temporary")
            publish(operation, plan_id)

        with patch.object(self.installer, "publish", side_effect=interrupt):
            with self.assertRaises(InterruptedError):
                self.installer.apply_plan(plan)
        self.installer.apply_plan(plan)
        self.assertEqual(self.installer.verify(self.home, self.project)["verified"], 67)
        self.assertFalse(list(self.home.rglob("*.sieun-pi-*")))

    def test_interrupted_json_publication_cleans_temporary(self):
        plan = self.plan()
        publish = self.installer.publish

        def interrupt(operation, plan_id):
            if operation["kind"] == "generated-json":
                temporary = self.installer.generated_temporary(operation, plan_id)
                temporary.write_bytes(self.installer.json_bytes(operation["value"]))
                temporary.chmod(0o600)
                os.link(temporary, operation["target"])
                raise InterruptedError("published JSON temporary remains")
            publish(operation, plan_id)

        with patch.object(self.installer, "publish", side_effect=interrupt):
            with self.assertRaises(InterruptedError):
                self.installer.apply_plan(plan)
        self.installer.apply_plan(plan)
        self.assertFalse(list(self.home.rglob("*.sieun-pi-*")))

    def test_interrupted_empty_receipt_directory_resumes(self):
        plan = self.plan()
        receipt = self.installer.receipt_location(self.home, plan["id"])
        (receipt.parent / "backups").mkdir(parents=True)
        self.installer.apply_plan(plan)
        self.assertEqual(self.installer.verify(self.home, self.project)["verified"], 67)

    def test_rollback_refuses_target_drift_before_any_restore(self):
        plan = self.plan()
        receipt = self.installer.apply_plan(plan)
        target = Path(self.operation(plan, "virev-projects")["target"])
        target.write_text("changed after apply\n")
        with self.assertRaisesRegex(self.installer.InstallError, "drift"):
            self.installer.rollback_receipt(receipt)
        self.assertTrue(Path(plan["operations"][0]["target"]).is_symlink())
        self.assertEqual(target.read_text(), "changed after apply\n")

    def test_rollback_refuses_backup_drift(self):
        self.write_home(".prime/agent/skills/architect/old.txt", b"old source")
        receipt = self.installer.apply_plan(self.plan())
        (receipt.parent / "backups/0/old.txt").write_text("changed backup")
        with self.assertRaisesRegex(self.installer.InstallError, "drift"):
            self.installer.rollback_receipt(receipt)
        self.assertTrue((self.home / ".prime/agent/skills/architect").is_symlink())

    def test_rollback_keeps_unmanaged_settings_changes(self):
        settings = self.write_home(".prime/agent/settings.json", b"{}\n")
        receipt = self.installer.apply_plan(self.plan())
        settings.write_bytes(b'{"changed by Prime":true}\n')
        self.installer.rollback_receipt(receipt)
        self.assertEqual(settings.read_bytes(), b'{"changed by Prime":true}\n')

    def test_rollback_after_source_edit_does_not_delete_edit(self):
        plan = self.plan()
        receipt = self.installer.apply_plan(plan)
        source = Path(self.operation(plan, "agent-rules")["source"])
        source.write_text("source edit remains\n")
        self.installer.rollback_receipt(receipt)
        self.assertEqual(source.read_text(), "source edit remains\n")

    def test_interrupted_rollback_resumes(self):
        self.write_home(".prime/agent/AGENTS.md", b"previous rules")
        receipt = self.installer.apply_plan(self.plan())
        rename = os.rename

        def interrupt(source, target):
            rename(source, target)
            raise InterruptedError("after restore")

        with patch.object(self.installer.os, "rename", side_effect=interrupt):
            with self.assertRaises(InterruptedError):
                self.installer.rollback_receipt(receipt)
        self.installer.rollback_receipt(receipt)
        self.assertEqual((self.home / ".prime/agent/AGENTS.md").read_bytes(), b"previous rules")

    def test_modified_plan_cannot_expand_ownership(self):
        plan = self.plan()
        plan["operations"][0]["target"] = str(self.home / "unrelated")
        with self.assertRaisesRegex(self.installer.InstallError, "Source or plan changed"):
            self.installer.apply_plan(plan)

    def test_modified_receipt_cannot_expand_ownership(self):
        receipt = self.installer.apply_plan(self.plan())
        data = json.loads(receipt.read_text())
        data["plan"]["operations"][0]["target"] = str(self.home / "unrelated")
        receipt.write_text(json.dumps(data))
        with self.assertRaisesRegex(self.installer.InstallError, "outside manifest ownership"):
            self.installer.rollback_receipt(receipt)

    def test_global_virev_is_backed_up_and_restored(self):
        target = self.write_home(".prime/agent/extensions/virev.ts", b"global extension")
        receipt = self.installer.apply_plan(self.plan())
        self.assertTrue(target.is_symlink())
        self.installer.rollback_receipt(receipt)
        self.assertEqual(target.read_bytes(), b"global extension")

    def test_global_virev_settings_registration_requires_review(self):
        self.write_home(".prime/agent/settings.json", b'{"extensions":["/old/source/virev.ts"]}')
        with self.assertRaisesRegex(self.installer.InstallError, "duplicate extensions registration"):
            self.plan()

    def test_legacy_history_whole_package_link_is_backed_up(self):
        legacy_source = self.home / "code/prime-agent-user-history"
        legacy_source.mkdir(parents=True)
        (legacy_source / "source.ts").write_text("original source")
        legacy = self.home / ".prime/agent/extensions/what-did-i-say"
        legacy.parent.mkdir(parents=True)
        legacy.symlink_to(legacy_source)
        receipt = self.installer.apply_plan(self.plan())
        self.assertFalse(legacy.is_symlink())
        self.assertEqual((legacy_source / "source.ts").read_text(), "original source")
        self.installer.rollback_receipt(receipt)
        self.assertEqual(legacy.resolve(), legacy_source)

    def test_same_basename_at_unknown_history_source_is_not_removed(self):
        unknown_source = self.home / "other/prime-agent-user-history"
        unknown_source.mkdir(parents=True)
        (unknown_source / "source.ts").write_text("unrelated user package")
        legacy = self.home / ".prime/agent/extensions/what-did-i-say"
        legacy.parent.mkdir(parents=True)
        legacy.symlink_to(unknown_source)
        with self.assertRaisesRegex(self.installer.InstallError, "unknown legacy extension"):
            self.plan()
        self.assertEqual(os.readlink(legacy), str(unknown_source))
        self.assertEqual((unknown_source / "source.ts").read_text(), "unrelated user package")
        self.assertFalse((self.home / ".local/state").exists())

    def test_unknown_legacy_history_is_not_removed(self):
        self.write_home(".prime/agent/extensions/what-did-i-say/user.txt", b"user data")
        with self.assertRaisesRegex(self.installer.InstallError, "unknown legacy extension"):
            self.plan()

    def test_project_migration_preserves_old_files_in_backups(self):
        files = {"extensions/virev.ts": b"old source", "ext-impl/virev/index.mjs": b"old impl",
                 "virev-project.json": b'{"project":"auto-sns-agent"}'}
        for name, content in files.items():
            target = self.project / ".prime/agent" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        unrelated = self.project / ".prime/agent/notes.txt"
        unrelated.write_text("user data")
        receipt = self.installer.apply_plan(self.plan())
        for name in files:
            self.assertFalse((self.project / ".prime/agent" / name).exists())
        self.assertEqual(unrelated.read_text(), "user data")
        self.installer.rollback_receipt(receipt)
        for name, content in files.items():
            self.assertEqual((self.project / ".prime/agent" / name).read_bytes(), content)

    def test_projects_config_preserves_unrelated_entries_and_fields(self):
        other = self.base / "other"
        value = {"projects": [{"root": str(other), "policy": "other-policy", "custom": 1}], "custom": "keep"}
        config = self.write_home(".prime/agent/virev-projects.json", json.dumps(value).encode())
        original = config.read_bytes()
        receipt = self.installer.apply_plan(self.plan())
        updated = json.loads(config.read_text())
        self.assertEqual(updated["custom"], "keep")
        self.assertEqual(updated["projects"][0], value["projects"][0])
        self.assertEqual(updated["projects"][1], {"root": str(self.project), "policy": "auto-sns-agent"})
        self.installer.apply_plan(json.loads(receipt.read_text())["plan"])
        next_plan = self.plan()
        self.assertTrue(all(op["before"] == op["after"] for op in next_plan["operations"]))
        self.installer.rollback_receipt(receipt)
        self.assertEqual(config.read_bytes(), original)

    def test_without_project_preserves_config_bytes_and_does_not_enable_policy(self):
        raw = b'{ "projects": [], "user": true }\n'
        config = self.write_home(".prime/agent/virev-projects.json", raw)
        receipt = self.installer.apply_plan(self.plan(project=False))
        self.assertEqual(config.read_bytes(), raw)
        self.installer.rollback_receipt(receipt)
        self.assertEqual(config.read_bytes(), raw)

    def test_project_policy_conflict_rejected(self):
        self.write_home(".prime/agent/virev-projects.json", json.dumps({"projects": [
            {"root": str(self.project), "policy": "different"}]}).encode())
        with self.assertRaisesRegex(self.installer.InstallError, "different Virev policy"):
            self.plan()

    def test_project_is_explicit(self):
        plan = self.plan(project=False)
        self.assertEqual(len(plan["operations"]), 64)
        self.installer.apply_plan(plan)
        self.assertEqual(list(self.project.iterdir()), [])
        self.assertEqual(self.installer.verify(self.home, None)["project"], "not selected")

    def test_multiple_projects_update_and_rollback_in_reverse_order(self):
        first = self.installer.apply_plan(self.plan())
        other = self.base / "second-project"
        other.mkdir()
        second_plan = self.installer.make_plan(self.home, other)
        second = self.installer.apply_plan(second_plan)
        config = self.home / ".prime/agent/virev-projects.json"
        self.assertEqual([item["root"] for item in json.loads(config.read_text())["projects"]], [str(self.project), str(other)])
        self.installer.rollback_receipt(second)
        self.assertEqual([item["root"] for item in json.loads(config.read_text())["projects"]], [str(self.project)])
        self.installer.rollback_receipt(first)
        self.assertFalse(config.exists())

    def test_generated_test_artifacts_do_not_change_source_fingerprint(self):
        plan = self.plan()
        artifact = self.checkout / "components/user-history/.test-artifacts/session/auth.json"
        artifact.parent.mkdir(parents=True)
        artifact.write_text("synthetic test data")
        self.installer.apply_plan(plan)
        self.assertEqual(self.installer.verify(self.home, self.project)["verified"], 67)

    def test_state_inside_checkout_is_rejected(self):
        with self.assertRaisesRegex(self.installer.InstallError, "outside the checkout"):
            self.installer.make_plan(self.checkout / "profile", None)

    def test_plan_output_cannot_mutate_runtime(self):
        output = self.home / ".prime/agent/new-plan.json"
        result = self.cli("plan", "--home", str(self.home), "--out", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside managed runtime", result.stderr)
        self.assertFalse((self.home / ".prime").exists())

    def test_plan_output_in_checkout_requires_work(self):
        output = self.checkout / "plan.json"
        result = self.cli("plan", "--home", str(self.home), "--out", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ignored .work", result.stderr)
        self.assertFalse(output.exists())

    def test_cli_plan_apply_verify_rollback(self):
        output = self.base / "plan.json"
        result = self.cli("plan", "--home", str(self.home), "--project", str(self.project), "--out", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / ".prime").exists())
        result = self.cli("apply", "--plan", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)["receipt"]
        result = self.cli("verify", "--home", str(self.home), "--project", str(self.project))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["verified"], 67)
        result = self.cli("rollback", "--receipt", receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / ".prime/agent/settings.json").exists())


if __name__ == "__main__":
    unittest.main()

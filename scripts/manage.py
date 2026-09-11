#!/usr/bin/env python3
"""Install reviewed source links without managing Prime runtime state."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "install-manifest.json"
MISSING = {"kind": "missing"}
PROTECTED = {"auth.json", "models.json", "credentials.json", "sessions", "memories", "learned-memories", "tokenmaxxing", ".git"}
BUILD_DIRS = {".venv", "node_modules", "__pycache__", "dist", ".git", ".test-artifacts", ".pytest_cache", ".cache"}


class InstallError(Exception):
    pass


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def protect(path):
    for part in path.parts:
        if part in PROTECTED or part == ".env" or part.startswith(".env.") or part.endswith((".pem", ".key")):
            raise InstallError(f"Protected path is outside installer ownership: {path}")


def fingerprint(path, *, source=False):
    protect(path)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return MISSING.copy()
    if stat.S_ISLNK(mode):
        if source:
            raise InstallError(f"Source symlinks are not allowed: {path}")
        return {"kind": "link", "target": os.readlink(path)}
    if stat.S_ISREG(mode):
        return {"kind": "file", "sha256": digest(path.read_bytes()), "mode": stat.S_IMODE(mode)}
    if stat.S_ISDIR(mode):
        rows = []
        for child in sorted(path.iterdir()):
            if source and (child.name in BUILD_DIRS or child.suffix == ".pyc" or child.name == ".DS_Store"):
                continue
            rows.append([child.name, fingerprint(child, source=source)])
        return {"kind": "directory", "sha256": digest(json_bytes(rows)), "mode": stat.S_IMODE(mode)}
    raise InstallError(f"Unsupported filesystem entry: {path}")


def binding(value):
    path = Path(value).expanduser().absolute()
    if path.is_symlink():
        raise InstallError(f"Binding must be a real directory: {path}")
    path = path.resolve()
    if path.exists() and not path.is_dir():
        raise InstallError(f"Binding must be a directory: {path}")
    return path


def safe_parents(path, anchor):
    if not path.is_relative_to(anchor) or path == anchor:
        raise InstallError(f"Target escapes its binding: {path}")
    for parent in [anchor, *reversed(path.parent.relative_to(anchor).parents), path.parent.relative_to(anchor)]:
        current = parent if parent.is_absolute() else anchor / parent
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise InstallError(f"Unsafe symlink or non-directory parent: {current}")


def state_root(home):
    state = home / ".local/state/sieun-pi"
    if state.is_relative_to(ROOT):
        raise InstallError("Installer receipts and backups must be outside the checkout")
    safe_parents(state / "receipts", home)
    return state


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(json_bytes(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


@contextmanager
def installation_lock(home):
    state = state_root(home)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(state / "lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError("Another apply or rollback is running for this HOME") from error
        yield state
    finally:
        os.close(fd)


def reject_duplicate_registrations(home):
    extensions = home / ".prime/agent/extensions"
    safe_parents(extensions / "virev.ts", home)
    if extensions.exists():
        for entry in extensions.iterdir():
            if "virev" in entry.name.lower() and entry.name != "virev.ts":
                raise InstallError(f"Review the extra Virev registration before installing: {entry}")
    settings = home / ".prime/agent/settings.json"
    safe_parents(settings, home)
    if settings.is_symlink():
        raise InstallError(f"Settings must be an ordinary JSON file: {settings}")
    if settings.exists():
        value = json.loads(settings.read_text())
        if not isinstance(value, dict):
            raise InstallError("Settings must contain a JSON object")
        for key in ("extensions", "packages"):
            for item in value.get(key, []):
                name = str(item).lower()
                if "virev" in name or "prime-agent-user-history" in name or name.endswith("/user-history"):
                    raise InstallError(f"Review the duplicate {key} registration in settings: {item}")


def original_file(target, prior, home, plan_id):
    if prior is None:
        return target if target.exists() else None
    if prior["before"] == MISSING:
        return None
    if fingerprint(target) == prior["before"]:
        return target
    receipt = receipt_location(home, plan_id)
    saved = backup_path(receipt, prior["index"])
    safe_parents(saved, home)
    if fingerprint(saved) == prior["before"]:
        return saved
    raise InstallError(f"Destination changed after planning: {target}")


def projects_value(path, project):
    value = json.loads(path.read_text()) if path else {"projects": []}
    if not isinstance(value, dict) or not isinstance(value.get("projects"), list):
        raise InstallError("virev-projects.json must contain a projects array")
    projects = value["projects"]
    for entry in projects:
        if not isinstance(entry, dict) or not isinstance(entry.get("root"), str) or not Path(entry["root"]).is_absolute():
            raise InstallError("Each Virev project needs an absolute root")
        if not isinstance(entry.get("policy"), str):
            raise InstallError("Each Virev project needs a policy")
    if project is not None:
        matches = [entry for entry in projects if Path(entry["root"]).resolve() == project]
        if any(entry["policy"] != "auto-sns-agent" for entry in matches):
            raise InstallError(f"Project already has a different Virev policy: {project}")
        if not matches:
            projects.append({"root": str(project), "policy": "auto-sns-agent"})
    return value


def read_manifest():
    manifest = json.loads(MANIFEST.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("entries"), list):
        raise InstallError("Unsupported install manifest")
    return manifest


def specifications(home, project, plan=None):
    prior = {op["id"]: {**op, "index": i} for i, op in enumerate(plan["operations"])} if plan else {}
    specs = []
    ids, targets = set(), set()
    for entry in read_manifest()["entries"]:
        scope = entry["scope"]
        if scope not in {"home", "project"}:
            raise InstallError(f"Invalid manifest scope: {scope}")
        if scope == "project" and project is None:
            continue
        anchor = home if scope == "home" else project
        relative = Path(entry["target"])
        if relative.is_absolute() or ".." in relative.parts:
            raise InstallError(f"Invalid manifest target: {relative}")
        target = anchor / relative
        protect(target)
        if target.is_relative_to(ROOT):
            raise InstallError(f"Runtime target cannot be inside the checkout: {target}")
        safe_parents(target, anchor)
        if entry["id"] in ids or target in targets:
            raise InstallError("Manifest ids and targets must be unique")
        ids.add(entry["id"])
        targets.add(target)
        spec = {"id": entry["id"], "kind": entry["kind"], "target": str(target), "scope": scope}
        if "source" in entry:
            relative_source = Path(entry["source"])
            if relative_source.is_absolute() or ".." in relative_source.parts:
                raise InstallError(f"Invalid manifest source: {relative_source}")
            source = ROOT / relative_source
            safe_parents(source, ROOT)
            spec["source"] = str(source)
            spec["source_fingerprint"] = fingerprint(source, source=True)
            if spec["source_fingerprint"] == MISSING:
                raise InstallError(f"Missing manifest source: {source}")
        if entry["kind"] == "link":
            spec["after"] = {"kind": "link", "target": spec["source"]}
        elif entry["kind"] == "generated-json":
            spec["seed_only"] = entry["seed_only"]
            if entry.get("merge_projects"):
                spec["merge_projects"] = True
                old_file = original_file(target, prior.get(entry["id"]), home, plan["id"] if plan else None)
                if old_file and not old_file.is_file():
                    raise InstallError(f"Virev projects must be an ordinary JSON file: {target}")
                if target.is_symlink():
                    raise InstallError(f"Virev projects cannot be a symlink: {target}")
                spec["value"] = projects_value(old_file, project)
                old_value = json.loads(old_file.read_text()) if old_file else None
                spec["after"] = fingerprint(old_file) if old_value == spec["value"] else {
                    "kind": "file", "sha256": digest(json_bytes(spec["value"])), "mode": 0o600}
            else:
                spec["value"] = json.loads(Path(spec["source"]).read_text()) if "source" in spec else entry["value"]
                spec["after"] = {"kind": "file", "sha256": digest(json_bytes(spec["value"])), "mode": 0o600}
        elif entry["kind"] == "remove":
            if "link_target" in entry:
                spec["link_target"] = str(home / entry["link_target"])
                before = prior.get(entry["id"], {}).get("before", fingerprint(target))
                if before != MISSING and (before["kind"] != "link" or before["target"] != spec["link_target"]):
                    raise InstallError(f"Review the unknown legacy extension before removing it: {target}")
            spec["after"] = MISSING.copy()
        else:
            raise InstallError(f"Invalid operation kind: {entry['kind']}")
        specs.append(spec)
    return specs


def make_plan(home, project):
    state_root(home)
    reject_duplicate_registrations(home)
    operations = []
    for spec in specifications(home, project):
        before = fingerprint(Path(spec["target"]))
        if spec.get("seed_only") and before != MISSING:
            spec["after"] = before
        operations.append({**spec, "before": before})
    return {"version": 1, "id": uuid.uuid4().hex, "root": str(ROOT), "home": str(home),
            "project": str(project) if project else None, "manifest_sha256": digest(MANIFEST.read_bytes()),
            "operations": operations}


def plan_bindings(plan):
    if plan.get("version") != 1 or plan.get("root") != str(ROOT):
        raise InstallError("Plan belongs to a different schema or source checkout")
    try:
        if uuid.UUID(hex=plan["id"]).hex != plan["id"]:
            raise ValueError("noncanonical id")
    except (ValueError, KeyError, TypeError) as error:
        raise InstallError("Invalid plan id") from error
    home = binding(plan["home"])
    project = binding(plan["project"]) if plan["project"] else None
    if str(home) != plan["home"] or (project and str(project) != plan["project"]):
        raise InstallError("Plan bindings changed")
    state_root(home)
    return home, project


def validate_plan(plan):
    home, project = plan_bindings(plan)
    if digest(MANIFEST.read_bytes()) != plan["manifest_sha256"]:
        raise InstallError("Manifest changed after planning; create a new plan")
    reject_duplicate_registrations(home)
    specs = specifications(home, project, plan)
    if len(specs) != len(plan["operations"]):
        raise InstallError("Plan operations do not match the manifest")
    for spec, operation in zip(specs, plan["operations"]):
        if spec.get("seed_only") and operation["before"] != MISSING:
            spec["after"] = operation["before"]
        if {key: value for key, value in operation.items() if key != "before"} != spec:
            raise InstallError(f"Source or plan changed for {spec['id']}; create a new plan")
    return home, project


def receipt_location(home, plan_id):
    return state_root(home) / "receipts" / plan_id / "receipt.json"


def backup_path(receipt_path, index):
    return receipt_path.parent / "backups" / str(index)


def physical_state(operation, backup):
    target = fingerprint(Path(operation["target"]))
    saved = fingerprint(backup)
    before, after = operation["before"], operation["after"]
    if target == before and saved == MISSING:
        return "original"
    if target == after and saved == (before if before != MISSING else MISSING):
        return "installed"
    if before != MISSING and target == MISSING and saved == before:
        return "backed-up"
    raise InstallError(f"Destination or backup drift: {operation['target']}")


def validate_owned_operations(plan):
    home, project = plan_bindings(plan)
    entries = [entry for entry in read_manifest()["entries"] if entry["scope"] == "home" or project is not None]
    if len(entries) != len(plan["operations"]):
        raise InstallError("Receipt ownership no longer matches the manifest")
    for entry, operation in zip(entries, plan["operations"]):
        anchor = home if entry["scope"] == "home" else project
        expected = {"id": entry["id"], "kind": entry["kind"], "scope": entry["scope"],
                    "target": str(anchor / entry["target"])}
        if "source" in entry:
            expected["source"] = str(ROOT / entry["source"])
        if any(operation.get(key) != value for key, value in expected.items()):
            raise InstallError("Receipt operation is outside manifest ownership")
        if operation["kind"] == "link":
            after = {"kind": "link", "target": expected["source"]}
        elif operation["kind"] == "generated-json":
            if operation.get("seed_only") != entry["seed_only"]:
                raise InstallError("Receipt changed the settings policy")
            if "value" in entry and operation["value"] != entry["value"]:
                raise InstallError("Receipt changed generated JSON")
            after = {"kind": "file", "sha256": digest(json_bytes(operation["value"])), "mode": 0o600}
            if entry.get("merge_projects"):
                if operation.get("merge_projects") is not True:
                    raise InstallError("Receipt changed the project merge policy")
                if operation["before"] == operation["after"]:
                    after = operation["before"]
            if entry["seed_only"] and operation["before"] != MISSING:
                after = operation["before"]
        elif operation["kind"] == "remove":
            expected_link = str(home / entry["link_target"]) if "link_target" in entry else None
            if operation.get("link_target") != expected_link:
                raise InstallError("Receipt changed legacy removal ownership")
            if expected_link and operation["before"] != MISSING:
                if operation["before"] != {"kind": "link", "target": expected_link}:
                    raise InstallError("Receipt changed the exact legacy source link")
            after = MISSING.copy()
        else:
            raise InstallError("Unknown receipt operation")
        if operation["after"] != after:
            raise InstallError("Invalid receipt applied fingerprint")


def validate_receipt(receipt, receipt_path, *, rollback=False):
    plan = receipt["plan"]
    validate_owned_operations(plan)
    home, project = plan_bindings(plan)
    if receipt_path != receipt_location(home, plan["id"]):
        raise InstallError("Receipt must stay in its original external state directory")
    safe_parents(receipt_path, home)
    if len(receipt["changes"]) != len(plan["operations"]):
        raise InstallError("Invalid receipt changes")
    allowed_directories = set()
    for operation in plan["operations"]:
        anchor = home if operation["scope"] == "home" else project
        for directory in Path(operation["target"]).parents:
            if directory.is_relative_to(anchor):
                allowed_directories.add(str(directory))
    if any(directory not in allowed_directories for directory in receipt["created_directories"]):
        raise InstallError("Receipt directory is outside manifest ownership")
    allowed = {
        "pending": {"original"}, "prepared": {"original", "backed-up", "installed"},
        "applied": {"installed"}, "restoring": {"original", "backed-up", "installed"}, "restored": {"original"},
    }
    for index, (operation, change) in enumerate(zip(plan["operations"], receipt["changes"])):
        target = Path(operation["target"])
        safe_parents(target, home if operation["scope"] == "home" else project)
        if change["state"] == "unchanged":
            if not rollback and fingerprint(target) != operation["after"]:
                raise InstallError(f"Destination changed after planning: {target}")
            continue
        safe_parents(backup_path(receipt_path, index), home)
        check_temporary(operation, plan["id"])
        physical = physical_state(operation, backup_path(receipt_path, index))
        if physical not in allowed.get(change["state"], set()):
            raise InstallError(f"Destination drift in state {change['state']}: {target}")


def ensure_target_parents(target, anchor, receipt, receipt_path):
    safe_parents(target, anchor)
    missing = []
    parent = target.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for parent in reversed(missing):
        if str(parent) not in receipt["created_directories"]:
            receipt["created_directories"].append(str(parent))
            save_json(receipt_path, receipt)
        parent.mkdir(mode=0o700, exist_ok=True)


def generated_temporary(operation, plan_id):
    target = Path(operation["target"])
    return target.with_name(f".{target.name}.sieun-pi-{plan_id}")


def check_temporary(operation, plan_id):
    if operation["kind"] != "generated-json":
        return
    temporary = generated_temporary(operation, plan_id)
    if not temporary.exists() and not temporary.is_symlink():
        return
    mode = temporary.lstat().st_mode
    if not stat.S_ISREG(mode) or stat.S_IMODE(mode) != 0o600:
        raise InstallError(f"Unsafe generated-file temporary path: {temporary}")
    if not json_bytes(operation["value"]).startswith(temporary.read_bytes()):
        raise InstallError(f"Generated-file temporary drift: {temporary}")


def publish(operation, plan_id):
    target = Path(operation["target"])
    if operation["kind"] == "remove":
        return
    if operation["kind"] == "link":
        os.symlink(operation["source"], target)
    else:
        temporary = generated_temporary(operation, plan_id)
        check_temporary(operation, plan_id)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(json_bytes(operation["value"]))
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target, follow_symlinks=False)
        temporary.unlink()
    sync_directory(target.parent)


def apply_plan(plan):
    home, project = validate_plan(plan)
    with installation_lock(home):
        validate_plan(plan)
        receipt_path = receipt_location(home, plan["id"])
        safe_parents(receipt_path, home)
        if receipt_path.is_symlink():
            raise InstallError("Receipt cannot be a symlink")
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            if receipt["plan"] != plan:
                raise InstallError("Existing receipt does not match the plan")
            if receipt["state"] not in {"applying", "applied"}:
                raise InstallError("This plan was rolled back; create a new plan")
            validate_receipt(receipt, receipt_path)
        else:
            for operation in plan["operations"]:
                if fingerprint(Path(operation["target"])) != operation["before"]:
                    raise InstallError(f"Destination changed after planning: {operation['target']}")
            receipt_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            (receipt_path.parent / "backups").mkdir(mode=0o700, exist_ok=True)
            receipt = {"version": 1, "state": "applying", "plan": plan, "created_directories": [],
                       "changes": [{"state": "unchanged" if op["before"] == op["after"] else "pending"}
                                   for op in plan["operations"]]}
            save_json(receipt_path, receipt)
        for index, (operation, change) in enumerate(zip(plan["operations"], receipt["changes"])):
            if change["state"] in {"unchanged", "applied"}:
                continue
            target = Path(operation["target"])
            anchor = home if operation["scope"] == "home" else project
            safe_parents(target, anchor)
            backup = backup_path(receipt_path, index)
            physical = physical_state(operation, backup)
            change["state"] = "prepared"
            save_json(receipt_path, receipt)
            ensure_target_parents(target, anchor, receipt, receipt_path)
            if physical == "original" and operation["before"] != MISSING:
                os.rename(target, backup)
                sync_directory(target.parent)
                sync_directory(backup.parent)
                physical = "backed-up"
            if physical != "installed":
                if fingerprint(target) != MISSING:
                    raise InstallError(f"Destination changed during apply: {target}")
                publish(operation, plan["id"])
            change["state"] = "applied"
            save_json(receipt_path, receipt)
        for operation in plan["operations"]:
            if operation["kind"] == "generated-json":
                temporary = generated_temporary(operation, plan["id"])
                check_temporary(operation, plan["id"])
                if temporary.exists():
                    temporary.unlink()
        receipt["state"] = "applied"
        save_json(receipt_path, receipt)
    return receipt_path


def rollback_receipt(receipt_path):
    if receipt_path.name != "receipt.json" or len(receipt_path.parents) < 6:
        raise InstallError("Expected an external installer receipt.json")
    inferred_home = receipt_path.parents[5]
    if receipt_path != receipt_location(inferred_home, receipt_path.parent.name):
        raise InstallError("Expected an external installer receipt.json")
    safe_parents(receipt_path, inferred_home)
    if receipt_path.is_symlink():
        raise InstallError("Receipt cannot be a symlink")
    receipt = json.loads(receipt_path.read_text())
    home, _ = plan_bindings(receipt["plan"])
    with installation_lock(home):
        validate_receipt(receipt, receipt_path, rollback=True)
        receipt["state"] = "rolling-back"
        save_json(receipt_path, receipt)
        pairs = list(zip(receipt["plan"]["operations"], receipt["changes"]))
        for index in reversed(range(len(pairs))):
            operation, change = pairs[index]
            if change["state"] in {"unchanged", "restored"}:
                continue
            backup = backup_path(receipt_path, index)
            physical = physical_state(operation, backup)
            change["state"] = "restoring"
            save_json(receipt_path, receipt)
            target = Path(operation["target"])
            if physical == "installed":
                if operation["kind"] != "remove":
                    target.unlink()
                    sync_directory(target.parent)
                physical = "backed-up" if operation["before"] != MISSING else "original"
            if physical == "backed-up":
                os.rename(backup, target)
                sync_directory(target.parent)
                sync_directory(backup.parent)
            if operation["kind"] == "generated-json":
                temporary = generated_temporary(operation, receipt["plan"]["id"])
                if temporary.exists():
                    temporary.unlink()
            change["state"] = "restored"
            save_json(receipt_path, receipt)
        for name in reversed(receipt["created_directories"]):
            directory = Path(name)
            if directory.is_symlink():
                raise InstallError(f"Created directory became a symlink: {directory}")
            try:
                directory.rmdir()
            except (FileNotFoundError, OSError):
                pass
        receipt["state"] = "rolled-back"
        save_json(receipt_path, receipt)
    return receipt_path


def verify(home, project, check_patch=False):
    reject_duplicate_registrations(home)
    specs = specifications(home, project)
    errors = []
    for spec in specs:
        current = fingerprint(Path(spec["target"]))
        if spec.get("seed_only") and current != MISSING:
            continue
        if current != spec["after"]:
            errors.append(spec["target"])
    if errors:
        raise InstallError("Managed targets do not match source: " + ", ".join(errors))
    if check_patch:
        env = {**os.environ, "HOME": str(home), "PI_POOL_DIR": str(home / ".config/pi-pool"),
               "PRIME_AGENT_CODING_AGENT_DIR": str(home / ".prime/agent")}
        result = subprocess.run([sys.executable, "-B", str(ROOT / "components/pi-pool/vend.py"), "--cli", "patch", "--check"], env=env)
        if result.returncode:
            raise InstallError(f"Pool patch check failed with exit code {result.returncode}")
    return {"verified": len(specs), "project": str(project) if project else "not selected", "patch_checked": check_patch}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "verify"):
        command = commands.add_parser(name)
        command.add_argument("--home", default=str(Path.home()))
        command.add_argument("--project")
        if name == "plan":
            command.add_argument("--out", type=Path, required=True)
        else:
            command.add_argument("--check-patch", action="store_true")
    commands.add_parser("apply").add_argument("--plan", type=Path, required=True)
    for name in ("rollback", "uninstall"):
        commands.add_parser(name).add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command in {"plan", "verify"}:
            home = binding(args.home)
            project = binding(args.project) if args.project else None
            if args.command == "plan":
                plan = make_plan(home, project)
                output = args.out.absolute()
                protect(output)
                if output.exists() or output.is_symlink():
                    raise InstallError(f"Plan output already exists; choose a new path: {output}")
                output = output.resolve()
                protect(output)
                runtime = [home / ".prime", home / ".config/pi-pool", home / ".local/bin", state_root(home)]
                if project is not None:
                    runtime.append(project / ".prime")
                if any(output.is_relative_to(directory) for directory in runtime):
                    raise InstallError("Plan output must be outside managed runtime directories")
                if output.is_relative_to(ROOT) and not output.is_relative_to(ROOT / ".work"):
                    raise InstallError("Plan output inside the checkout must use ignored .work")
                output.parent.mkdir(parents=True, exist_ok=True)
                save_json(output, plan)
                print(json.dumps({"plan": str(output), "changes": sum(op["before"] != op["after"] for op in plan["operations"]),
                                  "project": plan["project"] or "not selected"}))
            else:
                print(json.dumps(verify(home, project, args.check_patch)))
        elif args.command == "apply":
            protect(args.plan.absolute())
            if args.plan.is_symlink():
                raise InstallError("Plan cannot be a symlink")
            print(json.dumps({"receipt": str(apply_plan(json.loads(args.plan.read_text())))}))
        else:
            protect(args.receipt.absolute())
            print(json.dumps({"receipt": str(rollback_receipt(args.receipt.absolute()))}))
    except (InstallError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"sieun-pi: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

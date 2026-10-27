from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .bash import BashHandle

JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL"
CRASH_ENV = "PRIME_AGENT_TEST_HANDOFF_CRASH"
RECEIPT_KIND = "prime-agent/detached-handoff-receipt"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_COMMAND_CAP = 2000
_USER_HZ = 100


class HandoffError(Exception):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.details = details

    def reply(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "message": str(self), **self.details}


class ReceiptsUnreadable(Exception):
    def __init__(self, path: str, error_class: str) -> None:
        super().__init__(f"{path}: {error_class}")
        self.path = path
        self.error_class = error_class


def receipts_root() -> str | None:
    journal = os.environ.get(JOURNAL_ENV)
    return os.path.join(os.path.dirname(journal), "detached-handoffs") if journal else None


def session_key(session_id: str) -> str:
    if _ID.match(session_id):
        return session_id
    return "s-" + hashlib.sha256(session_id.encode()).hexdigest()[:32]


def boot_id() -> str | None:
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _stat(pid: int) -> tuple[str, int, str] | None:
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read()
        fields = raw[raw.rindex(b")") + 2 :].split()
        return fields[0].decode(), int(fields[2]), fields[19].decode()
    except (OSError, ValueError, IndexError):
        return None


def start_time(pid: int) -> str | None:
    stat = _stat(pid)
    return stat[2] if stat else None


def cgroup_of(pid: int | str) -> str | None:
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            for line in f:
                if line.startswith("0::"):
                    return line[3:].strip()
    except OSError:
        return None
    return None


def within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def group_members(pgid: int) -> list[dict[str, Any]]:
    members = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        stat = _stat(int(name))
        if stat is None or stat[0] == "Z" or stat[1] != pgid:
            continue
        members.append({"pid": int(name), "startTime": stat[2], "cgroup": cgroup_of(name) or ""})
    members.sort(key=lambda member: (member["pid"] != pgid, member["pid"]))
    return members


def uptime_ticks() -> str:
    with open("/proc/uptime") as f:
        return str(int(float(f.read().split()[0]) * _USER_HZ))


def _load(path: str) -> dict[str, Any]:
    try:
        with open(path) as f:
            data = json.load(f)
    except OSError as error:
        raise ReceiptsUnreadable(path, _errno_class(error)) from error
    except ValueError as error:
        raise ReceiptsUnreadable(path, "invalid_json") from error
    if not isinstance(data, dict) or data.get("kind") != RECEIPT_KIND or not isinstance(data.get("state"), str):
        raise ReceiptsUnreadable(path, "invalid_shape")
    return data


def _errno_class(error: OSError) -> str:
    import errno

    return errno.errorcode.get(error.errno or 0, "OSError")


def _listdir(path: str) -> list[str]:
    try:
        return os.listdir(path)
    except FileNotFoundError:
        return []
    except OSError as error:
        raise ReceiptsUnreadable(path, _errno_class(error)) from error


def load_receipts(root: str) -> list[dict[str, Any]]:
    receipts = []
    for key in sorted(_listdir(root)):
        directory = os.path.join(root, key)
        if key == "stop-intents" or not os.path.isdir(directory):
            continue
        for name in sorted(_listdir(directory)):
            if name.endswith(".json") and not name.startswith("."):
                receipts.append(_load(os.path.join(directory, name)))
    return receipts


def transferred_leaders(root: str | None) -> set[tuple[int, str]]:
    if root is None:
        return set()
    current = boot_id()
    leaders = set()
    for receipt in load_receipts(root):
        if receipt["state"] not in ("committed", "stopped") or receipt.get("bootId") != current:
            continue
        for group in receipt.get("groups", []):
            leader = group.get("leader", {})
            leaders.add((leader.get("pid"), f"proc:{leader.get('startTime')}"))
    return leaders


def leader_transferred(pid: int, process_start_id: str | None) -> bool:
    try:
        return (pid, process_start_id) in transferred_leaders(receipts_root())
    except ReceiptsUnreadable as error:
        import sys

        sys.stderr.write(f"detached handoff receipts unreadable: {error.path}: {error.error_class}\n")
        return True


def append_journal(path: str, record: dict[str, Any]) -> bool:
    data = (json.dumps(record) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    return False
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        return False
    return True


def _transferred_record(original: dict[str, Any], receipt_id: str) -> dict[str, Any]:
    return {
        "version": 1,
        "pid": original["pid"],
        "ownerPid": original["ownerPid"],
        **({"kernelPid": original["kernelPid"]} if "kernelPid" in original else {}),
        "active": False,
        "transferred": receipt_id,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }


def complete_on_start() -> int:
    journal = os.environ.get(JOURNAL_ENV)
    root = receipts_root()
    if not journal or root is None:
        return 0
    try:
        with open(journal) as f:
            lines = f.read().splitlines()
    except OSError:
        return 0
    latest: dict[int, dict[str, Any]] = {}
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and isinstance(record.get("pid"), int):
            latest[record["pid"]] = record
    try:
        receipts = load_receipts(root)
    except ReceiptsUnreadable as error:
        import sys

        sys.stderr.write(f"detached handoff receipts unreadable: {error.path}: {error.error_class}\n")
        return 0
    current = boot_id()
    completed = 0
    for receipt in receipts:
        if receipt["state"] not in ("committed", "stopped") or receipt.get("bootId") != current:
            continue
        for group in receipt.get("groups", []):
            leader = group.get("leader", {})
            record = latest.get(leader.get("pid"))
            if (
                record is not None
                and record.get("active") is True
                and record.get("processStartId") == f"proc:{leader.get('startTime')}"
                and append_journal(journal, _transferred_record(record, receipt["receiptId"]))
            ):
                completed += 1
    return completed


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _link_new(directory: str, name: str, payload: dict[str, Any]) -> bool:
    temp = os.path.join(directory, f".tmp-{uuid.uuid4().hex}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, (json.dumps(payload, indent=2) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temp, os.path.join(directory, name))
        return True
    except FileExistsError:
        return False
    finally:
        os.unlink(temp)
        _fsync_dir(directory)


def _crash_point(point: str) -> None:
    value = os.environ.get(CRASH_ENV)
    if value == f"{point}:worker":
        owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID", "")
        if owner.isdigit():
            os.kill(int(owner), signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)
    elif value == point:
        os.kill(os.getpid(), signal.SIGKILL)


def _require_ids(req: dict[str, Any]) -> tuple[str, str]:
    session_id, handoff_id = req.get("sessionId"), req.get("handoffId")
    if not isinstance(session_id, str) or not session_id or len(session_id) > 512:
        raise HandoffError("handoff_invalid_request", "sessionId must be a non-empty string")
    if not isinstance(handoff_id, str) or not _ID.match(handoff_id):
        raise HandoffError("handoff_invalid_request", "handoffId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}")
    return session_id, handoff_id


def _supported_root() -> str:
    root = receipts_root()
    if root is None or os.name != "posix" or not os.path.isdir("/proc/self") or cgroup_of("self") is None:
        raise HandoffError("handoff_unsupported", "detached handoff needs Linux /proc, cgroup v2 and an orphan journal")
    return root


def _existing(root: str, session_id: str, handoff_id: str) -> dict[str, Any] | None:
    path = os.path.join(root, session_key(session_id), f"{handoff_id}.json")
    if not os.path.exists(path):
        return None
    try:
        return _load(path)
    except ReceiptsUnreadable as error:
        raise HandoffError(
            "ownership_unresolved",
            f"receipt unreadable: {error.error_class}",
            sessionId=session_id,
            handoffId=handoff_id,
            unresolved=[{"handoffId": handoff_id, "errorClass": error.error_class}],
            intentPersisted=False,
        ) from error


def _refuse_existing(existing: dict[str, Any], session_id: str, handoff_id: str) -> None:
    if existing["state"] == "aborted":
        raise HandoffError("handoff_aborted", "this handoff was aborted", sessionId=session_id, handoffId=handoff_id)
    raise HandoffError(
        "handoff_already_committed",
        "this handoff is committed",
        sessionId=session_id,
        handoffId=handoff_id,
        receipt=existing,
    )


def _candidate(handle: BashHandle) -> dict[str, Any] | None:
    if not handle._handoff_candidate():
        return None
    members = group_members(handle._pid)
    leader = next((member for member in members if member["pid"] == handle._pid), None)
    if leader is None:
        return None
    return {
        "pgid": handle._pid,
        "leader": {"pid": leader["pid"], "startTime": leader["startTime"]},
        "members": members,
        "command": handle.command[:_COMMAND_CAP],
        "cgroup": leader["cgroup"],
    }


def prepare(handles: list[BashHandle], req: dict[str, Any]) -> dict[str, Any]:
    session_id, handoff_id = _require_ids(req)
    root = _supported_root()
    existing = _existing(root, session_id, handoff_id)
    if existing is not None:
        _refuse_existing(existing, session_id, handoff_id)
    groups = [group for group in (_candidate(handle) for handle in handles) if group is not None]
    return {"ok": True, "handoffId": handoff_id, "sessionId": session_id, "bootId": boot_id(), "groups": groups}


def _parse_identity(value: Any) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("pid"), int)
        or isinstance(value.get("pid"), bool)
        or value["pid"] <= 0
        or not isinstance(value.get("startTime"), str)
        or not value["startTime"].isdigit()
    ):
        raise HandoffError("handoff_invalid_request", "an identity needs a positive pid and a decimal startTime")
    return {"pid": value["pid"], "startTime": value["startTime"]}


def _parse_groups(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise HandoffError("handoff_invalid_request", "groups must be a non-empty list")
    groups = []
    for raw in value:
        if not isinstance(raw, dict) or not isinstance(raw.get("cgroup"), str) or not isinstance(raw.get("members"), list):
            raise HandoffError("handoff_invalid_request", "a group needs pgid, leader, members and cgroup")
        leader = _parse_identity(raw.get("leader"))
        if raw.get("pgid") != leader["pid"]:
            raise HandoffError("handoff_invalid_request", "leader.pid must equal pgid")
        groups.append(
            {
                "pgid": leader["pid"],
                "leader": leader,
                "members": [_parse_identity(member) for member in raw["members"]],
                "cgroup": raw["cgroup"],
            }
        )
    if len({group["pgid"] for group in groups}) != len(groups):
        raise HandoffError("handoff_invalid_request", "pgids must be distinct")
    return groups


def _same_groups(receipt: dict[str, Any], groups: list[dict[str, Any]]) -> bool:
    stored = {(group["pgid"], group["leader"]["startTime"]) for group in receipt.get("groups", [])}
    return stored == {(group["pgid"], group["leader"]["startTime"]) for group in groups}


def _verify(handle: BashHandle | None, group: dict[str, Any], session_id: str, kernel_cgroup: str) -> dict[str, Any]:
    pgid = group["pgid"]
    if handle is None or not handle._handoff_owned():
        raise HandoffError("handoff_group_not_owned", f"pgid {pgid} is not a live bash() group of this kernel", sessionId=session_id, pids=[pgid])
    if not handle._handoff_candidate():
        raise HandoffError("handoff_group_not_detached", f"pgid {pgid} still holds the handle's output", sessionId=session_id, pids=[pgid])
    if start_time(pgid) != group["leader"]["startTime"]:
        raise HandoffError("handoff_identity_mismatch", f"leader {pgid} changed identity", sessionId=session_id, pids=[pgid])
    target = group["cgroup"]
    if not target.startswith("/") or within(kernel_cgroup, target):
        raise HandoffError("handoff_invalid_target_cgroup", f"{target!r} is not a cgroup outside the kernel's", sessionId=session_id)
    exited = []
    reused = []
    for member in group["members"]:
        now = start_time(member["pid"])
        if now is None:
            exited.append(member)
        elif now != member["startTime"]:
            reused.append(member["pid"])
    if reused:
        raise HandoffError("handoff_identity_mismatch", "listed pids changed identity", sessionId=session_id, pids=reused)
    live = group_members(pgid)
    outside = [member["pid"] for member in live if not within(member["cgroup"], target)]
    if outside:
        raise HandoffError("handoff_not_in_target_cgroup", f"members outside {target}", sessionId=session_id, pids=outside)
    return {
        "pgid": pgid,
        "cgroup": target,
        "leader": group["leader"],
        "members": [{"pid": member["pid"], "startTime": member["startTime"]} for member in live],
        "exited": exited,
    }


def commit(handles: list[BashHandle], req: dict[str, Any]) -> dict[str, Any]:
    session_id, handoff_id = _require_ids(req)
    root = _supported_root()
    groups = _parse_groups(req.get("groups"))
    existing = _existing(root, session_id, handoff_id)
    if existing is not None:
        return _replay(existing, groups, session_id, handoff_id)
    by_pid = {handle._pid: handle for handle in handles}
    chosen = [by_pid.get(group["pgid"]) for group in groups]
    locks = [handle._kill_lock for handle in chosen if handle is not None]
    for lock in locks:
        lock.acquire()
    try:
        kernel_cgroup = cgroup_of("self") or "/"
        verified = [_verify(handle, group, session_id, kernel_cgroup) for handle, group in zip(chosen, groups)]
        current_boot = boot_id()
        if current_boot is None:
            raise HandoffError("handoff_unsupported", "no boot id", sessionId=session_id)
        receipt_id = f"rcpt-{uuid.uuid4().hex}"
        receipt = {
            "version": 1,
            "kind": RECEIPT_KIND,
            "handoffId": handoff_id,
            "receiptId": receipt_id,
            "state": "committed",
            "sessionId": session_id,
            **({"sessionFile": req["sessionFile"]} if isinstance(req.get("sessionFile"), str) else {}),
            "kernelPid": os.getpid(),
            "ownerPid": int(os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID", "0") or 0),
            "bootId": current_boot,
            "committedAt": datetime.now(timezone.utc).isoformat(),
            "committedAtTicks": uptime_ticks(),
            "groups": verified,
            "stops": [],
        }
        directory = os.path.join(root, session_key(session_id))
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            linked = _link_new(directory, f"{handoff_id}.json", receipt)
        except OSError as error:
            raise HandoffError(
                "handoff_receipt_write_failed", f"receipt write failed: {_errno_class(error)}", sessionId=session_id, handoffId=handoff_id
            ) from error
        if not linked:
            existing = _existing(root, session_id, handoff_id)
            assert existing is not None
            return _replay(existing, groups, session_id, handoff_id)
        _crash_point("after-receipt")
        for handle in chosen:
            assert handle is not None
            handle._relinquish(receipt_id)
        _crash_point("after-relinquish")
        return {"ok": True, "handoffId": handoff_id, "sessionId": session_id, "replayed": False, "receipt": receipt}
    finally:
        for lock in locks:
            lock.release()


def _replay(existing: dict[str, Any], groups: list[dict[str, Any]], session_id: str, handoff_id: str) -> dict[str, Any]:
    if existing["state"] == "aborted":
        raise HandoffError("handoff_aborted", "this handoff was aborted", sessionId=session_id, handoffId=handoff_id)
    if existing.get("sessionId") != session_id or not _same_groups(existing, groups):
        raise HandoffError(
            "handoff_id_conflict", "this handoffId is committed with other groups", sessionId=session_id, handoffId=handoff_id, receipt=existing
        )
    return {"ok": True, "handoffId": handoff_id, "sessionId": session_id, "replayed": True, "receipt": existing}


def handle_request(handles: list[BashHandle], req: dict[str, Any]) -> dict[str, Any]:
    try:
        if req.get("type") == "handoff_prepare":
            return prepare(handles, req)
        return commit(handles, req)
    except HandoffError as error:
        details = error.reply()
        if "sessionId" not in details and isinstance(req.get("sessionId"), str):
            details["sessionId"] = req["sessionId"]
        return details

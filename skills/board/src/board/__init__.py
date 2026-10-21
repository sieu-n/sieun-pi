"""Read a browser chat's board (plan, owner todos, scratchpad) as plain text, set a kernel-free wake with wake(), and record what a job owns with own().

The chat server keeps each chat's board in <agent dir>/browser-chat/boards/<chat session id>.json. The chat_board tool shows only the open
checklist; these calls read the rest. A chat's kernel and every job under it find the chat from RLM_SESSION_DIR. corrections() reads the
owner's corrections ledger, <agent dir>/browser-chat/corrections.json, whose [corrections] block shows some rules by id and theme only.

On a box where hosts.json puts the chat role on another box, every call reads and writes through that chat service's API instead.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

__all__ = ["open", "get", "notes", "done", "todos", "corrections", "sends", "wake", "own"]

_OPEN = {"todo", "doing", "blocked"}
_MARKS = {"todo": "[ ]", "doing": "[~]", "done": "[x]", "blocked": "[!]", "dropped": "[-]"}
_ID = re.compile(r"^[\w-]{1,128}$")


class _Text(str):
    """A str that prints as itself when it is the last value of a cell."""

    def __repr__(self) -> str:
        return str(self)


def _agent_dir() -> Path:
    raw = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".prime" / "agent")
    return Path(raw).expanduser()


def _chat_host() -> tuple[str, dict] | None:
    """The chat host's base URL and access, when hosts.json puts the chat role on another box; None on the chat host or without hosts.json.

    A box without the chat role reads and writes the chat's files through the chat service's API, so a job there sees the one live board,
    ledger, send log and wake folder. The capability and token come from ~/.config/sieun-pi/chat-access.json (0600).
    """
    config = Path(os.environ.get("SIEUN_PI_CONFIG_DIR", str(Path.home() / ".config" / "sieun-pi")))
    try:
        hosts = json.loads(Path(os.environ.get("SIEUN_PI_HOSTS", str(config / "hosts.json"))).read_text())["hosts"]
    except (FileNotFoundError, KeyError, ValueError):
        return None
    me = socket.gethostname().split(".")[0].lower()
    holder = next((host for host in hosts if "chat" in host.get("roles", {})), None)
    if holder is None or holder.get("hostname", "").split(".")[0].lower() == me:
        return None
    role = holder["roles"]["chat"]
    url = (role.get("url") or f"http://{holder['address']}:{role['port']}").rstrip("/")
    access = json.loads((config / "chat-access.json").read_text())
    return f"{url}/{access['capability']}/", {"token": access["csrfToken"], "origin": url}


def _call(path: str, body: dict | None = None) -> bytes | None:
    """GET (or POST with body) a chat service route on the chat host; None for a 404."""
    base, access = _chat_host()  # type: ignore[misc]
    headers = {"Content-Type": "application/json", "X-Chat-Token": access["token"], "Origin": access["origin"]} if body is not None else {}
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(f"Chat service at {base.split('/', 3)[2]} answered {error.code}: {error.read().decode(errors='replace')[:300]}") from None


def _chat_id(chat: str | None) -> str:
    if chat:
        return chat.removeprefix("thread:")
    parts = Path(os.environ.get("RLM_SESSION_DIR", "")).parts
    if "session-artifacts" in parts and parts.index("session-artifacts") + 1 < len(parts):
        return parts[parts.index("session-artifacts") + 1]
    raise LookupError("No chat found: RLM_SESSION_DIR is not under session-artifacts. Pass chat=<chat session id>.")


class NoBoard(LookupError):
    """The chat has no board file yet: a fresh chat before its first chat_board write, or a root job's own id."""


def _load(chat: str | None) -> tuple[str, dict]:
    chat_id = _chat_id(chat)
    if not _ID.match(chat_id):
        raise ValueError(f"Not a session id: {chat_id!r}")
    if _chat_host():
        raw = _call(f"api/agent/board?chat={urllib.parse.quote(chat_id)}")
        if raw is None:
            raise NoBoard(f"No board for {chat_id} on the chat host. A root job started with create_session has its own id; pass chat=<chat session id>.")
        return chat_id, json.loads(raw)
    path = _agent_dir() / "browser-chat" / "boards" / f"{chat_id}.json"
    try:
        return chat_id, json.loads(path.read_text())
    except FileNotFoundError:
        raise NoBoard(f"No board for {chat_id} at {path}. A root job started with create_session has its own id; pass chat=<chat session id>.") from None


def _walk(items: list, depth: int = 0, above: tuple = ()):
    for item in items:
        yield item, depth, above
        yield from _walk(item.get("children", []), depth + 1, above + (item,))


def _has_open(item: dict) -> bool:
    return item.get("status") in _OPEN or any(_has_open(child) for child in item.get("children", []))


def _lower_is_better(target: dict) -> bool:
    """The goal's direction as targetOp in chat-board.ts reads it: its stored direction, else a target of 0 or under its current reading."""
    if target.get("direction"):
        return target["direction"] == "down"
    current = target.get("current")
    return target["target"] == 0 or (current is not None and current > target["target"])


def _target_text(target: dict) -> str:
    unit = target["unit"] if target["unit"] == "%" else f" {target['unit']}"
    if target.get("current") is None:
        return f"target {target['target']:g}{unit}, not measured"
    current, goal = target["current"], target["target"]
    if _lower_is_better(target):
        ratio = 1 if current <= goal else goal / current
        return f"{current:g}{unit}, target at most {goal:g}{unit} ({round(ratio * 100)}%, {'met' if current <= goal else 'not met'})"
    ratio = 1 if goal == 0 else current / goal
    return f"{current:g} / {goal:g}{unit} ({round(ratio * 100)}%)"


def _marks(item: dict) -> str:
    marks = []
    session = item.get("sessionId")
    if item.get("job"):
        marks.append(f"job {item['job']}" + (f" (thread:{session})" if session and session != item["job"] else ""))
    elif session:
        marks.append(f"thread:{session}")
    if item.get("waitUntil"):
        marks.append(f"waits until {item['waitUntil']}")
    if item.get("waitFor"):
        marks.append(f"waits for {item['waitFor']}")
    if item.get("kind") == "build" or re.match(r"build\b", item.get("text", "").strip(), re.I):
        marks.append("build")
    if item.get("go"):
        marks.append("needs owner's go")
    if item.get("target"):
        marks.append(_target_text(item["target"]))
    return f" ({', '.join(marks)})" if marks else ""


def _line(item: dict, depth: int) -> str:
    return f"{'  ' * (depth + 1)}{_MARKS.get(item.get('status', 'todo'), '[?]')} {item['id']} {item['text']}{_marks(item)}"


def _todo_line(todo: dict) -> str:
    extra = f", for {todo['step']}" if todo.get("step") else ""
    choices = f", choices: {' / '.join(todo['choices'])}" if todo.get("choices") else ""
    answer = f", answer: {todo['reply']}" if todo.get("reply") is not None else ""
    links = f", links: {' '.join(link['target'] for link in todo['links'])}" if todo.get("links") else ""
    return f"  {'[x]' if todo.get('done') else '[ ]'} {todo['id']} {todo['text']} (from {todo.get('from', '?')}{extra}){choices}{links}{answer}"


def _scratch_line(note: dict, depth: int) -> str:
    links = " ".join(f"[{link.get('label', '')}]({link['target']})" for link in note.get("links", []))
    return f"{'  ' * (depth + 1)}- {note['id']} {note['text']}{' ' + links if links else ''}"


def open(chat: str | None = None) -> str:  # noqa: A001
    """The open checklist, the same view chat_board shows: open goals and steps, open todos, and a count of the rest."""
    try:
        chat_id, board = _load(chat)
    except NoBoard as error:
        return _Text(f"{error} A fresh chat has no board until its first chat_board write, so its plan and todos are empty.")
    lines = [f"Chat thread:{chat_id}, board rev {board['rev']}. Open plan (goals and steps not done):"]
    hidden = 0

    def visit(items: list, depth: int) -> None:
        nonlocal hidden
        for item in items:
            if not _has_open(item):
                hidden += sum(1 for _ in _walk([item]))
                continue
            lines.append(_line(item, depth))
            visit(item.get("children", []), depth + 1)

    visit(board["plan"], 0)
    open_todos = [todo for todo in board["todos"] if not todo.get("done")]
    lines.append("Owner todos open:" if open_todos else "Owner todos open: none")
    lines += [_todo_line(todo) for todo in open_todos]
    lines.append(f"Not shown: {hidden} done or dropped steps, {len(board['todos']) - len(open_todos)} answered todos. "
                 "Read them with board.get(id), board.done(), board.todos(all=True), and search step notes with board.notes(text).")
    return _Text("\n".join(lines))


def get(id: str, chat: str | None = None) -> str:  # noqa: A002
    """One item in full: a plan item (pN) with note, requirements, target and every step under it, a todo (tN) or a note (sN)."""
    _, board = _load(chat)
    for item, _depth, above in _walk(board["plan"]):
        if item["id"] != id:
            continue
        lines = [f"{' > '.join(up['id'] for up in above) + ' > ' if above else ''}{item['id']} [{item.get('status')}] {item['text']}"]
        for key in ("job", "sessionId", "waitUntil", "waitFor", "go", "kind"):
            if item.get(key):
                lines.append(f"  {key}: {item[key]}")
        if item.get("note"):
            lines.append(f"  note: {item['note']}")
        for number, line in enumerate(item.get("requirements") or [], 1):
            evidence = f"; evidence: {line['evidence']}" if line.get("evidence") else ""
            note = f"; note: {line['note']}" if line.get("note") else ""
            lines.append(f"  requirement {number} [{line['status']}] {line['text']}{evidence}{note}")
        if item.get("target"):
            lines.append(f"  target {_target_text(item['target'])}: {json.dumps(item['target'])}")
        linked = [todo for todo in board["todos"] if todo.get("step") == id or re.search(rf"(?<![\w-]){re.escape(id)}(?![\w-])", todo["text"])]
        if linked:
            lines.append("  todos on it:")
            lines += ["  " + _todo_line(todo) for todo in linked]
        steps = [_line(step, depth) for step, depth, _ in _walk(item.get("children", []))]
        if steps:
            lines.append("  steps:")
            lines += ["  " + step for step in steps]
        return _Text("\n".join(lines))
    for todo in board["todos"]:
        if todo["id"] == id:
            return _Text(_todo_line(todo).strip() + f" (asked {todo.get('at', '?')})")
    for note, depth, _ in _walk(board.get("scratch", [])):
        if note["id"] == id:
            return _Text("\n".join([_scratch_line(note, 0).strip() + f" ({note.get('at', '?')})"] + [_scratch_line(child, d) for child, d, _ in _walk(note.get("children", []))]))
    return _Text(f"No item {id} on this board.")


def notes(query: str | None = None, chat: str | None = None) -> str:
    """The scratchpad as an indented list with links. With query, only the notes, step notes and requirements whose text has it (any case)."""
    _, board = _load(chat)
    if query is None:
        lines = [_scratch_line(note, depth) for note, depth, _ in _walk(board.get("scratch", []))]
        return _Text("\n".join(["Scratchpad:"] + (lines or ["  (empty)"])))
    needle = query.lower()
    lines = []
    for note, _depth, _ in _walk(board.get("scratch", [])):
        links = " ".join(link["target"] for link in note.get("links", []))
        if needle in f"{note['text']} {links}".lower():
            lines.append(_scratch_line(note, 0))
    for item, _depth, _ in _walk(board["plan"]):
        if item.get("note") and needle in item["note"].lower():
            lines.append(f"  {item['id']} note: {item['note']}")
        for number, line in enumerate(item.get("requirements") or [], 1):
            if needle in json.dumps(line).lower():
                lines.append(f"  {item['id']} requirement {number} [{line['status']}] {line['text']}")
    return _Text("\n".join([f"Notes with {query!r}:"] + (lines or ["  (none)"])))


def done(since: str | int | None = None, chat: str | None = None) -> str:
    """Done and dropped plan items with their notes, newest id last. since="p250" (or 250) keeps items from that id on."""
    _, board = _load(chat)
    floor = int(str(since).lstrip("p")) if since is not None else 0
    lines = []
    for item, _depth, above in _walk(board["plan"]):
        if item.get("status") not in ("done", "dropped") or int(item["id"].lstrip("p") or 0) < floor:
            continue
        where = f" (under {above[-1]['id']})" if above else ""
        lines.append(f"  {_MARKS[item['status']]} {item['id']} {item['text']}{where}{_marks(item)}")
        if item.get("note"):
            lines.append(f"      note: {item['note']}")
    return _Text("\n".join([f"Done or dropped ({len([l for l in lines if not l.startswith('      ')])}):"] + (lines or ["  (none)"])))


def todos(all: bool = False, chat: str | None = None) -> str:  # noqa: A002
    """The owner's open todos; all=True adds the answered ones with their answers."""
    _, board = _load(chat)
    picked = [todo for todo in board["todos"] if all or not todo.get("done")]
    return _Text("\n".join([f"Owner todos ({'all' if all else 'open'}):"] + ([_todo_line(todo) for todo in picked] or ["  (none)"])))


def _send_log() -> Path:
    """components/global-rules/send-log.ts sendLogPath, the same order."""
    if os.environ.get("GLOBAL_RULES_SEND_LOG"):
        return Path(os.environ["GLOBAL_RULES_SEND_LOG"])
    if os.environ.get("AGENT_CHAT_DATA_DIR"):
        return Path(os.environ["AGENT_CHAT_DATA_DIR"]) / "sends.jsonl"
    return _agent_dir() / "browser-chat" / "sends.jsonl"


def sends(match: str | None = None, since: str | None = None, chat: str | None = None) -> str:
    """Every outside send an agent made or tried (c37), one line each: when, allowed, refused or ran, which chat and session, the target and the OWNER_OK.

    match is a case-insensitive part of the target, such as "iwebfusion" or an email; since is an ISO time such as "2026-10-08".
    The send guards write each send they allow or refuse; older sends come from a backfill of the session transcripts.
    """
    path = _send_log()
    try:
        if _chat_host():
            text = _call("api/agent/sends")
            if text is None:
                raise FileNotFoundError
            raw = text.decode().splitlines()
            path = Path("chat host:sends.jsonl")
        else:
            raw = path.read_text().splitlines()
    except FileNotFoundError:
        return _Text(f"No send log at {path}, so no guard has judged a send there yet.")
    entries = []
    for line in raw:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    needle = (match or "").lower()
    hits = sorted(
        (e for e in entries
         if (not since or str(e.get("at", "")) >= since)
         and (not chat or e.get("chat") == chat or chat in str(e.get("session") or ""))
         and needle in f"{e.get('target', '')}\n{e.get('reason', '')}\n{e.get('ownerOk') or ''}".lower()),
        key=lambda e: str(e.get("at", "")),
    )
    scope = " ".join(part for part in (f'matching "{match}"' if match else "", f"since {since}" if since else "", f"in chat {chat}" if chat else "") if part)
    counts: dict[str, int] = {}
    for e in hits:
        counts[e.get("decision", "?")] = counts.get(e.get("decision", "?"), 0) + 1
    head = f"{len(hits)} outside sends in {path}{' ' + scope if scope else ''}: " + (", ".join(f"{n} {d}" for d, n in counts.items()) or "none") + "."
    lines = [f"  {e.get('at')} {e.get('decision')} {e.get('layer')} chat={e.get('chat') or '?'} session={e.get('session') or '?'} ok={e.get('ownerOk') or 'none'} :: {e.get('target')} ({e.get('reason')})" for e in hits]
    return _Text("\n".join([head, *lines]))


def corrections(id: str | None = None) -> str:  # noqa: A002
    """The owner's corrections in force, one full rule per line; with id ("c12"), that entry in full with the owner's words and what enforces it."""
    path = _agent_dir() / "browser-chat" / "corrections.json"
    try:
        if _chat_host():
            text = _call("api/agent/corrections")
            path = Path("chat host:corrections.json")
            if text is None:
                raise FileNotFoundError
            entries = json.loads(text).get("corrections", [])
        else:
            entries = json.loads(path.read_text()).get("corrections", [])
    except FileNotFoundError:
        return _Text(f"No corrections ledger at {path}.")
    if id is None:
        live = [entry for entry in entries if entry.get("status") != "retired"]
        lines = [f"  {entry['id']}{' (reopened)' if entry.get('status') == 'reopened' else ''} {entry['rule']}" for entry in live]
        return _Text("\n".join([f"Corrections in force ({len(live)}):"] + (lines or ["  (none)"])))
    for entry in entries:
        if entry.get("id") != id:
            continue
        handoff = entry.get("handoff")
        lines = [f"{entry['id']} [{entry.get('status')}] {entry['rule']}",
                 f"  enforced by {entry.get('enforcedBy')}: {entry.get('ref', '')}",
                 f"  theme: {' '.join(entry.get('theme', []))}",
                 f"  owner's words ({entry.get('at', '?')}): {entry.get('words', '')}"]
        if handoff:
            scope = "".join([f" naming {', '.join(handoff['with'])}" if handoff.get("with") else "",
                             f" in {' or '.join(handoff['env'])}" if handoff.get("env") else ""])
            lines.append(f"  steps on {', '.join(handoff.get('topics', []))}{scope} belong to {handoff.get('to')}")
        lines += [f"  repeated {repeat.get('at', '?')}: {repeat.get('words', '')}" for repeat in entry.get("repeats", [])]
        return _Text("\n".join(lines))
    return _Text(f"No correction {id} in {path}.")


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _own_session() -> str:
    """This kernel's session id: a root's RLM_SESSION_DIR is named for it, a subagent's holds its one <session id>.jsonl."""
    folder = Path(os.environ.get("RLM_SESSION_DIR", ""))
    if _UUID.match(folder.name):
        return folder.name
    if folder.name.startswith("sub-"):
        logs = [path.stem for path in folder.glob("*.jsonl") if _UUID.match(path.stem)]
        if len(logs) == 1:
            return logs[0]
    raise LookupError(f"No session id found from RLM_SESSION_DIR={folder}.")


def wake(run: int | str | None = None, at: str | float | None = None, note: str = "", repo: str | None = None, attempt: int | None = None) -> str:
    """Wake this session when CI run `run` finishes or at time `at` (ISO 8601 or epoch seconds), then end the turn with nothing running.

    The chat service sends the wake as an agent message, which reopens the session even after Prime passivated it, so the wait holds no
    Python kernel and no worker. `repo` ("owner/name") reads the run with gh instead of the local CI cache. `note` comes back in the wake.
    A run wake follows the run's latest attempt. `attempt` waits for that attempt or a later one, so a wake on a finished run waits for its rerun
    instead of going out at once on the old result.
    """
    if (run is None) == (at is None):
        raise ValueError("Pass exactly one of run=<run id> or at=<time>.")
    if run is not None:
        run_id = int(str(run).strip())
        if run_id <= 0:
            raise ValueError(f"Not a run id: {run!r}")
        if attempt is not None and int(attempt) < 1:
            raise ValueError(f"Not a run attempt: {attempt!r}")
        later = int(attempt) if attempt is not None and int(attempt) > 1 else None
        on: dict = {"kind": "run", "run": run_id, **({"repo": repo} if repo else {}), **({"attempt": later} if later else {})}
        key, what = f"run-{run_id}", f"run {run_id}{' in ' + repo if repo else ''}{f' attempt {later} or later' if later else ''} finishes"
    else:
        when = float(at) if isinstance(at, (int, float)) else datetime.fromisoformat(str(at).replace("Z", "+00:00")).timestamp()
        on = {"kind": "time", "at": int(when * 1000)}
        key, what = f"time-{int(when)}", f"it is {datetime.fromtimestamp(when, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    session = _own_session()
    parts = Path(os.environ.get("RLM_SESSION_DIR", "")).parts
    root = parts[parts.index("session-artifacts") + 1] if "session-artifacts" in parts and parts.index("session-artifacts") + 1 < len(parts) else session
    record = {"session": session, **({"root": root} if root != session and _UUID.match(root) else {}), "on": on, "note": note, "since": int(time.time() * 1000)}
    if _chat_host():
        # The chat service on the chat host keeps the wake and delivers it through this box's relay.
        where = json.loads(_call("api/agent/wakes", record) or b"{}").get("path", "the chat host")
        return _Text(f"Wake set: the chat service messages this session when {what}. End this turn now with no bash handle, sleep or wait left running, "
                     f"so Prime can unload the session while it waits. (chat host:{where})")
    data_dir = Path(os.environ["AGENT_CHAT_DATA_DIR"]) if os.environ.get("AGENT_CHAT_DATA_DIR") else _agent_dir() / "browser-chat"
    folder = data_dir / "wakes"
    try:
        quiet = time.time() - (folder / ".ticked").stat().st_mtime
    except FileNotFoundError:
        quiet = None
    if quiet is None or quiet > 120:
        raise RuntimeError(f"No chat service delivers wakes now ({folder / '.ticked'} is {'missing' if quiet is None else f'{int(quiet)} s old'}). "
                           "Wait inside this turn with await bash(...) instead.")
    path = folder / f"{session}-{key}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record))
    os.replace(tmp, path)
    return _Text(f"Wake set: the chat service messages this session when {what}. End this turn now with no bash handle, sleep or wait left running, "
                 f"so Prime can unload the session while it waits. ({path})")


_UNIT = re.compile(r"^[A-Za-z0-9:_.@-]{1,200}\.(service|scope|timer)$")
_OWNED_FILE = "owned.json"


def _owned_roots() -> list[str]:
    """The folders an owned path must lie strictly below, as the chat service's job end reads them (src/job-leftovers.ts OWNED_ROOTS)."""
    return ["/tmp", str(Path.home() / "scratch"), str(Path.home() / "work"), str(_agent_dir() / "session-artifacts")]


def _hosts() -> list[dict]:
    """The boxes in hosts.json, or none without the file."""
    config = Path(os.environ.get("SIEUN_PI_CONFIG_DIR", str(Path.home() / ".config" / "sieun-pi")))
    try:
        hosts = json.loads(Path(os.environ.get("SIEUN_PI_HOSTS", str(config / "hosts.json"))).read_text())["hosts"]
    except (FileNotFoundError, KeyError, ValueError, TypeError):
        return []
    return [host for host in hosts if isinstance(host, dict) and isinstance(host.get("name"), str)]


def _other_host(name: str) -> str | None:
    """The hosts.json name of box `name` (its name, hostname, address or ssh target), or None when it is this box."""
    hosts = _hosts()
    bare = name.split("@")[-1].split(".")[0].lower()
    host = next((host for host in hosts if name == host["name"] or name == host.get("ssh") or bare in {
        host["name"].lower(), str(host.get("hostname", "")).split(".")[0].lower(), str(host.get("address", ""))}), None)
    if host is None:
        address = name.split("@")[-1]
        host = next((host for host in hosts if address == host.get("address")), None)
    if host is None:
        raise ValueError(f"No host {name!r} in hosts.json ({', '.join(host['name'] for host in hosts) or 'no hosts.json'}).")
    if str(host.get("hostname", "")).split(".")[0].lower() == socket.gethostname().split(".")[0].lower():
        return None
    return host["name"]


_HOST_ROOTS = ("~/scratch/", "~/work/", "/tmp/")


def _host_path(raw: str) -> str:
    """A path on another box as its record keeps it, `~/...` or `/tmp/...`, so that box resolves it against its own home."""
    path = re.sub(r"^(?:\$HOME|\$\{HOME\}|/home/[^/]+|/Users/[^/]+)(?=/)", "~", str(raw).strip())
    if not path.startswith(("~/", "/tmp/")):
        raise ValueError(f"{raw} is not below ~/scratch, ~/work or /tmp on that box, so a job's end would never delete it.")
    path = ("~" if path.startswith("~/") else "") + os.path.normpath(path[1:] if path.startswith("~/") else path)
    if not path.startswith(_HOST_ROOTS) or ".." in path.split("/"):
        raise ValueError(f"{raw} is not below ~/scratch, ~/work or /tmp on that box, so a job's end would never delete it.")
    return path


def own(*paths: str, unit: str | None = None, host: str | None = None) -> str:
    """Record paths and a systemd user unit this session made to throw away, in <RLM_SESSION_DIR>/owned.json.

    When the job is deleted or archived, the chat service stops the recorded units and deletes the recorded paths that no process uses, and
    nothing else: a path a transcript or a command only names is never deleted. Record only what is yours to throw away, such as a git archive
    export, a rig or a systemd-run unit, never a report, evidence or a helper another job runs, and keep reports and evidence under ~/work/<job>/.
    A path must lie below /tmp, ~/scratch, ~/work or ~/.prime/agent/session-artifacts. `host` names the box (a hosts.json name such as
    "us-metal02", or an ssh target) where the paths lie when this session made them there over ssh; that box deletes them at the job's end.
    """
    folder = Path(os.environ.get("RLM_SESSION_DIR", ""))
    if not folder.name or not folder.is_dir():
        raise LookupError(f"No session folder found from RLM_SESSION_DIR={folder}.")
    other = _other_host(host) if host else None
    if other and unit is not None:
        raise ValueError("Record a unit without host=: the chat host stops the units a record names.")
    roots = _owned_roots()
    found: list[str] = []
    for raw in paths:
        if other:
            found.append(_host_path(raw))
            continue
        path = os.path.normpath(os.path.abspath(os.path.expanduser(str(raw))))
        home = str(Path.home())
        if not any(path.startswith(root + "/") for root in roots) or (path.startswith(home + "/") and not any(
                root.startswith(home + "/") and path.startswith(root + "/") for root in roots)):
            raise ValueError(f"{raw} is not below {', '.join(roots)}, so a job's end would never delete it.")
        if path == str(folder) or str(folder).startswith(path + "/"):
            raise ValueError(f"{raw} holds this session's own folder, which a job's end never deletes.")
        found.append(path)
    if unit is not None and not _UNIT.match(unit):
        raise ValueError(f"Not a systemd unit name: {unit!r} (a name ending in .service, .scope or .timer).")
    file = folder / _OWNED_FILE
    try:
        record = json.loads(file.read_text())
    except (FileNotFoundError, ValueError):
        record = {}
    record_paths = [item for item in record.get("paths", []) if isinstance(item, str)]
    record_units = [item for item in record.get("units", []) if isinstance(item, str)]
    hosts = {name: [item for item in items if isinstance(item, str)] for name, items in (record.get("hosts") or {}).items() if isinstance(items, list)}
    if other:
        hosts[other] = hosts.get(other, []) + [path for path in found if path not in hosts.get(other, [])]
    else:
        record_paths += [path for path in found if path not in record_paths]
    record = {"paths": record_paths, "units": record_units + ([unit] if unit and unit not in record_units else []), **({"hosts": hosts} if hosts else {})}
    tmp = file.with_suffix(".tmp")
    tmp.write_text(json.dumps(record))
    os.replace(tmp, file)
    away = "".join(f", {len(items)} on {name}" for name, items in hosts.items())
    return _Text(f"Owned by this session ({file}): {len(record['paths'])} paths{away}, units {', '.join(record['units']) or 'none'}. "
                 "Its end deletes these paths and stops these units, and nothing else.")


# Every Prime kernel pre-imports this module, so it gives the chat service's watch a way to interrupt a hung cell
# (components/user-history/src/hung-stop.ts). At 05:51Z on 10-20 d7 read rb-api-portal 96 min into one ipython call, a backtracking
# re.findall at 0.99 cores, and the watch had no bash() command to stop. Prime's kernel (rlm/repl.py) interrupts a cell only on an interrupt
# frame from its worker, sent when a turn is aborted, and drops a SIGINT from anyone else. Nothing outside the worker can write that frame:
# the request channel is a socketpair, and ptrace_scope 1 keeps another process from taking its fd.
#
# The SIGUSR2 handler runs on the main thread between bytecodes or inside a C loop that checks signals, such as the re engine. It marks the
# running request as the interrupt's target and calls the SIGINT handler, which raises KeyboardInterrupt into a running cell or cancels an
# awaiting one, so the call returns a KeyboardInterrupt error and the kernel keeps its variables. A snapshot or restore parks SIGINT under a
# handler of its own, and the handler calls whatever SIGINT handler is installed, so a park still holds. An awaiting cell leaves the event
# loop asleep in select(), so the handler wakes it first, as the kernel's own interrupt does. The watch sends SIGUSR2 only to a kernel whose
# /proc status shows it caught, since the default action ends the process.
_INTERRUPT = signal.SIGUSR2


def _interrupt_cell(signum: int, frame: object) -> None:
    repl = sys.modules.get("rlm.repl")
    active = getattr(repl, "_active", None)
    if not isinstance(active, dict) or active.get("rid") is None:
        return
    handler = signal.getsignal(signal.SIGINT)
    if not callable(handler):
        return
    repl._sigint_target = active["rid"]
    loop = getattr(repl, "_loop", None)
    if loop is not None:
        loop.call_soon_threadsafe(lambda: None)
    handler(signal.SIGINT, frame)


def _install_interrupt() -> bool:
    """Installs the handler on a Prime kernel's main thread; False anywhere else, or when SIGUSR2 already has another handler."""
    repl = sys.modules.get("rlm.repl")
    if repl is None or not all(hasattr(repl, name) for name in ("_active", "_sigint_target", "_sigint_handler")):
        return False
    current = signal.getsignal(_INTERRUPT)
    if threading.current_thread() is not threading.main_thread() or (current is not signal.SIG_DFL and getattr(current, "__name__", "") != "_interrupt_cell"):
        return False
    signal.signal(_INTERRUPT, _interrupt_cell)
    return True


_install_interrupt()

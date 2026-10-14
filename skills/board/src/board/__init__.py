"""Read a browser chat's board (plan, owner todos, scratchpad) as plain text.

The chat server keeps each chat's board in <agent dir>/browser-chat/boards/<chat session id>.json. The chat_board tool shows only the open
checklist; these calls read the rest. A chat's kernel and every job under it find the chat from RLM_SESSION_DIR. corrections() reads the
owner's corrections ledger, <agent dir>/browser-chat/corrections.json, whose [corrections] block shows some rules by id and theme only.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

__all__ = ["open", "get", "notes", "done", "todos", "corrections", "sends"]

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


def _chat_id(chat: str | None) -> str:
    if chat:
        return chat.removeprefix("thread:")
    parts = Path(os.environ.get("RLM_SESSION_DIR", "")).parts
    if "session-artifacts" in parts and parts.index("session-artifacts") + 1 < len(parts):
        return parts[parts.index("session-artifacts") + 1]
    raise LookupError("No chat found: RLM_SESSION_DIR is not under session-artifacts. Pass chat=<chat session id>.")


def _load(chat: str | None) -> tuple[str, dict]:
    chat_id = _chat_id(chat)
    if not _ID.match(chat_id):
        raise ValueError(f"Not a session id: {chat_id!r}")
    path = _agent_dir() / "browser-chat" / "boards" / f"{chat_id}.json"
    try:
        return chat_id, json.loads(path.read_text())
    except FileNotFoundError:
        raise LookupError(f"No board for {chat_id} at {path}. A root job started with create_session has its own id; pass chat=<chat session id>.") from None


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _walk(items: list, depth: int = 0, above: tuple = ()):
    for item in items:
        yield item, depth, above
        yield from _walk(item.get("children", []), depth + 1, above + (item,))


def _has_open(item: dict) -> bool:
    return item.get("status") in _OPEN or any(_has_open(child) for child in item.get("children", []))


def _target_text(target: dict) -> str:
    unit = target["unit"] if target["unit"] == "%" else f" {target['unit']}"
    if target.get("current") is None:
        return f"target {target['target']:g}{unit}, not measured"
    return f"{target['current']:g} / {target['target']:g}{unit} ({round(target['current'] / target['target'] * 100)}%)"


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
        marks.append(f"waits for {_clip(item['waitFor'], 60)}")
    if item.get("kind") == "build" or re.match(r"build\b", item.get("text", "").strip(), re.I):
        marks.append("build")
    if item.get("go"):
        marks.append("needs owner's go")
    if item.get("target"):
        marks.append(_target_text(item["target"]))
    return f" ({', '.join(marks)})" if marks else ""


def _line(item: dict, depth: int, limit: int | None = 110) -> str:
    text = item["text"] if limit is None else _clip(item["text"], limit)
    return f"{'  ' * (depth + 1)}{_MARKS.get(item.get('status', 'todo'), '[?]')} {item['id']} {text}{_marks(item)}"


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
    chat_id, board = _load(chat)
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
    notes_count = sum(1 for _ in _walk(board["scratch"]))
    lines.append(f"Not shown: {hidden} done or dropped steps, {len(board['todos']) - len(open_todos)} answered todos, {notes_count} notes. "
                 "Read them with board.get(id), board.notes(), board.done(), board.todos(all=True).")
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
        steps = [_line(step, depth, None) for step, depth, _ in _walk(item.get("children", []))]
        if steps:
            lines.append("  steps:")
            lines += ["  " + step for step in steps]
        return _Text("\n".join(lines))
    for todo in board["todos"]:
        if todo["id"] == id:
            return _Text(_todo_line(todo).strip() + f" (asked {todo.get('at', '?')})")
    for note, depth, _ in _walk(board["scratch"]):
        if note["id"] == id:
            return _Text("\n".join([_scratch_line(note, 0).strip() + f" ({note.get('at', '?')})"] + [_scratch_line(child, d) for child, d, _ in _walk(note.get("children", []))]))
    return _Text(f"No item {id} on this board.")


def notes(query: str | None = None, chat: str | None = None) -> str:
    """The scratchpad as an indented list with links. With query, only the notes, step notes and requirements whose text has it (any case)."""
    _, board = _load(chat)
    if query is None:
        lines = [_scratch_line(note, depth) for note, depth, _ in _walk(board["scratch"])]
        return _Text("\n".join(["Scratchpad:"] + (lines or ["  (empty)"])))
    needle = query.lower()
    lines = []
    for note, _depth, _ in _walk(board["scratch"]):
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
            lines.append(f"  steps on {', '.join(handoff.get('topics', []))} belong to {handoff.get('to')}")
        lines += [f"  repeated {repeat.get('at', '?')}: {repeat.get('words', '')}" for repeat in entry.get("repeats", [])]
        return _Text("\n".join(lines))
    return _Text(f"No correction {id} in {path}.")

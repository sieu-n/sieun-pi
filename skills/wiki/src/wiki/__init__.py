"""Read and write the wiki on :5184 from a kernel: a job's workspace folder, its log, its pages and files, and curated pages.

The wiki engine is sieun-pi apps/wiki (sieun-pi-wiki.service on us-metal02), and the apps/chat server on :5184 fronts it at /wiki. In a
pi-host thread's kernel (PI_HOST_THREAD set, or RLM_SESSION_DIR named <thread>-<n>) every call names the conversation in x-pi-conversation,
so the server stamps the agent, the conversation, the parent and the host, and the agent never types its identity. A Prime session has no
pi-host conversation; it calls the engine's agent API through /wiki/api/agent/* with the author it is given (author=, WIKI_AUTHOR, or
"prime (<session>)").
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

__all__ = ["workspace", "write", "edit", "put", "log", "close", "publish", "search", "read", "supersede", "WikiError"]

SPACES = ("sessions", "agents", "apps", "domains", "projects", "experiments", "archive", "index.html")
PUBLIC = "https://us-metal02-dev.tail0c093d.ts.net:5184/wiki"
_CONVERSATION = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$", re.I)
_SLUG = re.compile(r"[^a-z0-9]+")


class WikiError(RuntimeError):
    """The server refused a call; status is its HTTP status and body its JSON answer or text."""

    def __init__(self, status: int, body, what: str):
        self.status, self.body = status, body
        detail = body.get("error", body) if isinstance(body, dict) else body
        super().__init__(f"{what} answered {status}: {str(detail)[:1500]}")


def conversation() -> str | None:
    """This kernel's pi-host conversation, `<thread>` or `<thread>:<n>`; None in a Prime session."""
    thread = os.environ.get("PI_HOST_THREAD", "").strip()
    if thread:
        n = os.environ.get("PI_HOST_CONVERSATION", "1").strip() or "1"
        return thread if n == "1" else f"{thread}:{n}"
    match = _CONVERSATION.match(Path(os.environ.get("RLM_SESSION_DIR", "")).name)
    if match and "pi-host" in os.environ.get("RLM_SESSION_DIR", ""):
        return match[1] if match[2] == "1" else f"{match[1]}:{match[2]}"
    return None


def _hosts_wiki() -> tuple[str | None, str | None]:
    """The hostname that holds the wiki role in hosts.json and that role's public URL."""
    config = Path(os.environ.get("SIEUN_PI_CONFIG_DIR", str(Path.home() / ".config" / "sieun-pi")))
    try:
        hosts = json.loads(Path(os.environ.get("SIEUN_PI_HOSTS", str(config / "hosts.json"))).read_text())["hosts"]
    except (OSError, KeyError, ValueError):
        return None, None
    holder = next((host for host in hosts if "wiki" in host.get("roles", {})), None)
    if holder is None:
        return None, None
    return holder.get("hostname", ""), holder["roles"]["wiki"].get("url")


def public_url() -> str:
    """The wiki's URL for people, `https://<box>:5184/wiki`."""
    url = os.environ.get("WIKI_PUBLIC_URL") or _hosts_wiki()[1] or PUBLIC
    return url.rstrip("/") if url.rstrip("/").endswith("/wiki") else PUBLIC


def base_url() -> str:
    """The :5184 origin the calls go to: PI_HOST_CHAT_URL, else loopback on the wiki host, else the public origin."""
    if os.environ.get("PI_HOST_CHAT_URL"):
        return os.environ["PI_HOST_CHAT_URL"].rstrip("/")
    holder, _url = _hosts_wiki()
    if holder is None or holder.split(".")[0].lower() == socket.gethostname().split(".")[0].lower():
        return "http://127.0.0.1:5184"
    return public_url().removesuffix("/wiki")


def _state_file() -> Path | None:
    session = os.environ.get("RLM_SESSION_DIR", "").strip()
    return Path(session) / "wiki-workspace.json" if session else None


def _state() -> dict:
    path = _state_file()
    try:
        return json.loads(path.read_text()) if path else {}
    except (OSError, ValueError):
        return {}


def _save(state: dict) -> None:
    path = _state_file()
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=1))


def _author(author: str | None = None) -> str:
    if author:
        return author
    if os.environ.get("WIKI_AUTHOR"):
        return os.environ["WIKI_AUTHOR"]
    if _state().get("author"):
        return _state()["author"]
    session = os.environ.get("RLM_SESSION_DIR", "")
    parts = Path(session).parts
    if "session-artifacts" in parts and parts.index("session-artifacts") + 1 < len(parts):
        tail = parts[parts.index("session-artifacts") + 1:]
        return f"prime ({'/'.join(tail)})"
    return "prime (unknown session)"


def _call(method: str, path: str, body=None, *, raw: bytes | None = None, content_type: str | None = None, text: bool = False, timeout: float = 120):
    """One request to the :5184 server; the JSON answer (or text), or WikiError."""
    headers = {"accept": "text/markdown" if text else "application/json"}
    data = raw
    if body is not None:
        data, content_type = json.dumps(body).encode(), "application/json"
    if content_type:
        headers["content-type"] = content_type
    if conversation():
        headers["x-pi-conversation"] = conversation()  # type: ignore[assignment]
    url = base_url() + path
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload)
        except ValueError:
            parsed = payload
        raise WikiError(error.code, parsed, f"{method} {path}") from None
    except urllib.error.URLError as error:
        raise WikiError(0, str(error.reason), f"{method} {url} (no answer)") from None
    if text:
        return payload
    try:
        return json.loads(payload) if payload.strip() else {}
    except ValueError:
        return payload


def _quote(path: str) -> str:
    return "/".join(urllib.parse.quote(part) for part in path.split("/"))


def _slug(text: str) -> str:
    return (_SLUG.sub("-", text.lower()).strip("-")[:60].rstrip("-")) or "job"


def _url(path: str) -> str:
    return f"{public_url()}/{path}"


def workspace(goal: str | None = None, *, slug: str | None = None, title: str | None = None, apps: list[str] | None = None,
              tags: list[str] | None = None, author: str | None = None) -> dict:
    """This conversation's workspace folder, opened on the first call: {path, folder, url, ...}.

    In a pi-host job it is `agents/<slug>/jobs/YYYY/MM/DD/hhmm-<job>/` (or `sessions/...` for a thread with no agent), and an agent's work
    thread gets its notebook `agents/<slug>/work/`. A Prime session opens `sessions/YYYY/MM/DD/hhmm-<slug>/` and needs `goal` the first time.
    """
    state = _state()
    if state.get("workspace") and not any((goal, slug, title, apps, tags)):
        return state["workspace"]
    extra = {key: value for key, value in {"goal": goal, "slug": slug, "title": title, "apps": apps, "tags": tags}.items() if value}
    if conversation():
        got = _call("POST", f"/api/c/{urllib.parse.quote(conversation())}/workspace", extra)  # type: ignore[arg-type]
    else:
        if author:
            state["author"] = author
        if not goal and not state.get("workspace"):
            raise ValueError("A Prime session has no pi-host conversation, so its first wiki.workspace() call names the goal: "
                             "wiki.workspace('what this job does', author='<who writes>').")
        if state.get("workspace"):
            return state["workspace"]
        got = _call("POST", "/wiki/api/agent/sessions", {"slug": slug or _slug(goal or "job"), "goal": goal, "agent": _author(author),
                                                         **{k: v for k, v in extra.items() if k not in ("goal", "slug")}})
        got["path"] = f"{got['id']}/index.html" if "id" in got else got.get("path")
    path = got.get("path") or ""
    folder = path if path.endswith("/") else path.rsplit("/", 1)[0] + "/"
    record = {"kind": got.get("kind", "session"), "id": got.get("id"), "path": path, "folder": folder, "url": _url(path),
              **({"conversation": got["conversation"]} if got.get("conversation") else {})}
    state["workspace"] = record
    _save(state)
    return record


def _folder() -> str:
    return workspace()["folder"]


def _path(name: str) -> str:
    """A wiki path: `name` as given when it starts in a content space, else under the workspace folder."""
    name = name.lstrip("/")
    if name.startswith(("apps/llm-wiki/content/", "content/")):
        raise ValueError(f"{name}: a wiki path starts at the content root, such as sessions/... or apps/...; drop the disk prefix.")
    return name if name.split("/")[0] in SPACES else _folder() + name


def _page_write(path: str, content: str, summary: str | None, author: str | None, markdown: bool, base_version: int | None) -> dict:
    if conversation():
        query = {k: v for k, v in {"format": "md" if markdown else None, "summary": summary,
                                     "baseVersion": base_version}.items() if v is not None}
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        kind = "text/markdown" if markdown else "text/html; charset=utf-8"
        return _call("PUT", f"/wiki/{_quote(path)}{suffix}", raw=content.encode(), content_type=kind)
    if markdown:
        raise ValueError("A markdown body converts to HTML only through a pi-host conversation's PUT; send HTML from a Prime session.")
    body = {"path": path, "content": content, "author": _author(author),
            **({"summary": summary} if summary else {}), **({"baseVersion": base_version} if base_version is not None else {})}
    return _call("POST", "/wiki/api/agent/page", body)


def write(name: str, content: str, *, summary: str | None = None, markdown: bool = False, base_version: int | None = None,
          author: str | None = None) -> dict:
    """Create or replace a page in the workspace (`plan.html`), or at a full wiki path; the gates' 422 comes back as WikiError."""
    path = _path(name)
    got = _page_write(path, content, summary, author, markdown, base_version)
    return {**got, "path": path, "url": _url(path)} if isinstance(got, dict) else got


def edit(name: str, edits, *, summary: str | None = None, base_version: int | None = None, author: str | None = None) -> dict:
    """Exact-string edits to a page: [(old, new), ...] or [{old_string, new_string, replace_all?}]."""
    path = _path(name)
    rows = [e if isinstance(e, dict) else {"old_string": e[0], "new_string": e[1]} for e in edits]
    body = {"edits": rows, **({"summary": summary} if summary else {}), **({"baseVersion": base_version} if base_version is not None else {})}
    if conversation():
        got = _call("PATCH", f"/wiki/{_quote(path)}", body)
    else:
        got = _call("PATCH", "/wiki/api/agent/page", {"path": path, "author": _author(author), **body})
    return {**got, "path": path, "url": _url(path)}


def put(name: str, file: str | os.PathLike) -> dict:
    """Upload a file that is not a page (a screenshot, data, a script, a log) into the workspace or at a full path."""
    path = _path(name)
    source = Path(file).expanduser()
    boundary = uuid.uuid4().hex
    kind = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{path}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{source.name}\"\r\n"
            f"Content-Type: {kind}\r\n\r\n").encode() + source.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    got = _call("POST", "/wiki/api/agent/assets", raw=body, content_type=f"multipart/form-data; boundary={boundary}")
    return {**got, "path": path, "url": _url(path)}


def _session_call(verb: str, body: dict, author: str | None) -> dict:
    if conversation():
        return _call("POST", f"/api/c/{urllib.parse.quote(conversation())}/workspace/{verb}", body)  # type: ignore[arg-type]
    current = workspace()
    return _call("POST", f"/wiki/api/agent/sessions/{_quote(current['id'])}/{verb}", {**body, "author": _author(author)})


def log(summary: str, html: str | None = None, *, author: str | None = None) -> dict:
    """Append an event to the workspace log."""
    return _session_call("events", {"summary": summary, **({"html": html} if html else {})}, author)


def close(outcome: str, graduated_to: list[str] | None = None, gaps_created: list[str] | None = None,
          no_durable_knowledge: bool = False, *, author: str | None = None) -> dict:
    """Close the workspace log; it needs graduated_to, gaps_created or no_durable_knowledge. Pages publish() wrote join graduated_to."""
    state = _state()
    graduated = list(dict.fromkeys([*(graduated_to or []), *state.get("graduated", [])]))
    body = {"outcome": outcome, **({"graduated_to": graduated} if graduated else {}),
            **({"gaps_created": gaps_created} if gaps_created else {}), **({"no_durable_knowledge": True} if no_durable_knowledge else {})}
    got = _session_call("close", body, author)
    state.pop("workspace", None)
    state.pop("graduated", None)
    _save(state)
    return got


def publish(path: str, html: str, *, summary: str | None = None, base_version: int | None = None, author: str | None = None) -> dict:
    """Write a curated page (apps/, domains/, projects/, experiments/) and run the verify gate; close() lists it in graduated_to."""
    if path.split("/")[0] not in SPACES or path.startswith(("sessions/", "agents/")):
        raise ValueError(f"{path}: publish() writes a curated page such as apps/<app>/index.html; write() takes workspace pages.")
    got = write(path, html, summary=summary, base_version=base_version, author=author)
    verify = _call("POST", "/wiki/api/agent/verify", {"path": path})
    state = _state()
    state["graduated"] = list(dict.fromkeys([*state.get("graduated", []), path]))
    _save(state)
    return {**got, "verify": verify}


def search(q: str, *, agent: str | None = None, sessions: bool = False, limit: int = 20, **filters) -> list[dict]:
    """Ranked page hits for q; agent='vent' keeps pages under agents/vent/, sessions=True adds session logs."""
    query = {"q": q, "limit": str(limit if not agent else max(limit * 5, 50)), **({"includeSessions": "true"} if sessions or agent else {}),
             **{k: str(v) for k, v in filters.items() if v is not None}}
    got = _call("GET", f"/wiki/api/agent/search?{urllib.parse.urlencode(query)}")
    rows = got.get("results", got.get("hits", [])) if isinstance(got, dict) else []
    if agent:
        prefix = f"agents/{agent.removeprefix('ag_')}/"
        rows = [row for row in rows if str(row.get("path", "")).startswith(prefix)]
    return rows[:limit]


def read(path: str, *, section: str | None = None, lines: str | None = None, html: bool = False) -> str:
    """A page as markdown (Turndown of the stored HTML), or its stored HTML with html=True."""
    query = {"format": "html" if html else "md", **({"section": section} if section else {}), **({"lines": lines} if lines else {})}
    return _call("GET", f"/wiki/{_quote(path.lstrip('/'))}?{urllib.parse.urlencode(query)}", text=True)


def supersede(old: str, new: str, *, summary: str | None = None, author: str | None = None) -> dict:
    """Mark old (even in a closed folder) as replaced by new."""
    who = _author(author) if not conversation() else author or f"conversation {conversation()}"
    return _call("POST", "/wiki/api/agent/supersede", {"path": old, "by": new, "author": who, **({"summary": summary} if summary else {})})

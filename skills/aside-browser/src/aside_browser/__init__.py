"""Drive the user's Aside browser (logged-in tabs) from the Python kernel.

Transport: prime-agent's generic MCP runtime (`rlm.mcp`) -> the `aside` stdio
server declared in ~/.prime/agent/settings.json (`aside mcp`). Each Prime Agent
kernel starts its own `aside mcp` process with one persistent Playwright-style
REPL. If the host has not loaded the `aside` server yet (needs `/reload` or a
new session), every call falls back to the one-shot CLI `aside repl`, which
loses state between calls; the returned text then starts with a
`[aside-browser fallback]` line.

On a Linux box, open_tab() and run() use a headful Chrome on this host by default (box/box.mjs, one runner per kernel,
each on its own Xvfb display), which exposes the same REPL globals, and later calls follow the tab's browser. Only a page
that needs one of the owner's logins goes to his Aside, because every Aside tab renders on his Mac.

`run()` guards the three most common agent mistakes found in an audit of
11,428 Aside REPL calls:

- Code runs inside an async function, so a `const`/`let` name can be reused in
  every call. `globalThis.name = value` keeps a value for later calls on purpose.
- Known failures (`document` outside `page.evaluate`, Playwright methods the
  Aside REPL lacks) raise an `AsideError` that names the working alternative.
- Tabs are owned by the agent session that opened them. `close_tab()` refuses
  other tabs unless `force=True`; `close_own_tabs()` closes only this session's.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import select
import socket
import subprocess
import sys
import tempfile
import threading
from typing import Any
from urllib.parse import urlsplit

SERVER = "aside"
CLI = os.environ.get("ASIDE_CLI") or shutil.which("aside") or os.path.expanduser("~/.local/bin/aside")
_B64_MARK = "__ASIDE_B64__:"
_OPENED_MARK = "__ASIDE_OPENED__:"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_STATUS = re.compile(r"^\[(ok|error) \| \d+ms\]$")
REGISTRY_FILE = "aside-browser-tabs.json"
BOX_PREFIX = "box-"
BOX_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "box"))


class AsideError(RuntimeError):
    """The Aside REPL raised, or the CLI/MCP transport failed. `hint` holds the added advice, if any."""

    def __init__(self, message: str, hint: str | None = None):
        super().__init__(message if not hint else f"{message}\n[aside-browser hint] {hint}")
        self.hint = hint


def _js_string(value: str) -> str:
    return json.dumps(value)


def _scoped(js: str) -> str:
    """Block-scope helper JS so its const names do not collide in the persistent REPL scope."""
    return "await (async () => { " + js + " })();"


# ---------------------------------------------------------------- code wrapping

_RESULT_PRINTER = (
    "(__asideValue) => { if (__asideValue === undefined) return; let __asideText; "
    "try { __asideText = typeof __asideValue === 'string' ? __asideValue : JSON.stringify(__asideValue); } "
    "catch (__asideErr) { __asideText = String(__asideValue); } "
    "console.log(__asideText === undefined ? String(__asideValue) : __asideText); }"
)
_TRACK_HEAD = "const __asideBefore = new Set((await listBrowserTabs()).map((t) => t.targetId)); try { "
_TRACK_TAIL = (
    " } finally { const __asideNew = tabs.filter((t) => t && t.targetId && !__asideBefore.has(t.targetId))"
    f".map((t) => t.targetId); if (__asideNew.length) console.log({_js_string(_OPENED_MARK)} + JSON.stringify(__asideNew)); }}"
)
_OPENS_TAB = re.compile(r"\bopenTab\s*\(")


def wrap_code(code: str, track_tabs: bool | None = None) -> str:
    """Wrap REPL code in an async function so `const`/`let` names never collide across calls.

    The user code starts on line 1, so REPL line numbers still match the caller's lines.
    A `return value` inside the code prints that value. With `track_tabs` (default: the code
    calls openTab), tabs opened by the code are reported back so this session owns them.
    """
    if track_tabs is None:
        track_tabs = bool(_OPENS_TAB.search(code))
    head = "await (async () => { " + (_TRACK_HEAD if track_tabs else "")
    tail = "\n" + (_TRACK_TAIL if track_tabs else "") + "})().then(" + _RESULT_PRINTER + ");"
    return head + code + tail


# ---------------------------------------------------------------- error translation

# Globals that exist only inside the web page, never in the Aside REPL (live probe 2026-10-01).
PAGE_GLOBALS = frozenset(
    "window document location navigator localStorage sessionStorage getComputedStyle history "
    "innerWidth innerHeight devicePixelRatio scrollX scrollY screen self frames matchMedia alert "
    "HTMLElement Element Node NodeFilter MutationObserver IntersectionObserver requestAnimationFrame "
    "CSS Event KeyboardEvent MouseEvent DOMParser XPathResult".split()
)
# REPL helpers that do not exist inside page.evaluate(...), which runs in the web page.
REPL_ONLY = frozenset(
    "sleep page tabs snapshot openTab closeTab listBrowserTabs attachBrowserTab attachActiveBrowserTab "
    "annotatedScreenshot display fs pwd path Buffer aside".split()
)
NO_NODE = frozenset("require process Bun module exports __dirname __filename".split())

_ON_LOCATOR = "page.locator(selector).{m}(...)"
# Methods that are `undefined` in the Aside REPL (live probe of Aside daemon 1.26.1001.14,
# 2026-10-01), mapped to the working alternative. Page and locator lists were probed separately.
MISSING_API: dict[str, str] = {
    "waitForTimeout": "Use `await sleep(ms)`.",
    "setViewportSize": "The tab is the user's real window and cannot be resized. Read the size with `page.viewportSize()` and work with it.",
    "context": "There is no browser context. Open a tab with `openTab(url)` (or `aside_browser.open_tab(url)`); list tabs with `listBrowserTabs()`.",
    "waitForFunction": "Poll instead: loop on `await page.evaluate(() => condition)` with `await sleep(200)`, or use `await page.waitForSelector(css)`.",
    "waitForNavigation": "Use `await page.waitForURL(urlOrRegex)` or `await page.waitForLoadState()`.",
    "waitForResponse": "Poll the page state with `page.evaluate(...)` or `snapshot(page)`; check an endpoint directly with `await fetch(url)`.",
    "waitForRequest": "Poll the page state with `page.evaluate(...)` or `snapshot(page)`; check an endpoint directly with `await fetch(url)`.",
    "$eval": "Use `await page.locator(css).evaluate(el => ...)`, or `page.$$eval(css, els => ...)`.",
    "evaluateHandle": "Use `await page.evaluate(...)` and return plain data.",
    "emulateMedia": "Not available. The tab uses the user's real color scheme and media settings.",
    "route": "Network interception is not available.",
    "unroute": "Network interception is not available.",
    "setExtraHTTPHeaders": "Not available. Use `await fetch(url, {headers})` for a request with custom headers.",
    "addInitScript": "Not available. Inject after load with `await page.evaluate(() => { ... })`.",
    "addScriptTag": "Not available. Inject after load with `await page.evaluate(() => { ... })`.",
    "addStyleTag": "Not available. Inject a <style> element with `await page.evaluate(css => { ... }, cssText)`.",
    "exposeFunction": "Not available. Pass data in and out through `page.evaluate(fn, arg)`.",
    "setDefaultTimeout": "Not available. Pass `{timeout: ms}` to each call.",
    "setDefaultNavigationTimeout": "Not available. Pass `{timeout: ms}` to each call.",
    "isClosed": "Not available. Check whether the tab's targetId is still in `await listBrowserTabs()`.",
    "setContent": "Not available. Open a real URL with `openTab(url)`.",
    "dragAndDrop": "Use `page.mouse.move/down/up`, or `locator.hover()` then the mouse calls.",
    "getByPlaceholder": "Use `page.locator('[placeholder=\"...\"]')`.",
    "getByTestId": "Use `page.locator('[data-testid=\"...\"]')`.",
    "getByAltText": "Use `page.locator('[alt=\"...\"]')`.",
    "getByTitle": "Use `page.locator('[title=\"...\"]')`.",
    "allInnerTexts": "Use `await locator.evaluateAll(els => els.map(e => e.innerText))`.",
    "allTextContents": "Use `await locator.evaluateAll(els => els.map(e => e.textContent))`.",
    "getByRole": "A locator has no getByRole. Call `page.getByRole(role, {name})` on `page`, or narrow with `locator.locator(css)`.",
    "getByText": "A locator has no getByText. Call `page.getByText(text)` on `page`, or use `page.locator(css).filter({hasText: text})`.",
    "getByLabel": "A locator has no getByLabel. Call `page.getByLabel(text)` on `page`.",
    "frameLocator": "A locator has no frameLocator. Call `page.frameLocator(css)` on `page`.",
    "and": "Combine the conditions in one CSS selector, or use `.filter({hasText})`.",
    "or": "Use a CSS selector list such as `page.locator('a, button')`.",
    "elementHandles": "Use `await locator.evaluateAll(els => ...)`, or `locator.nth(i)` with `locator.count()`.",
    "contentFrame": "Use `page.frameLocator(css)`.",
    "selectText": "Select inside the page with `locator.evaluate(el => el.select())`.",
    "highlight": "Not available. Use `aside_browser.screenshot(path, annotated=True)`.",
}
for _m in (
    "textContent innerText innerHTML getAttribute inputValue isVisible isHidden isEnabled isChecked "
    "hover focus check uncheck dblclick press type selectOption setInputFiles tap dispatchEvent"
).split():
    MISSING_API[_m] = f"`page` has no {_m}(selector) shortcut. Use `{_ON_LOCATOR.format(m=_m)}`."

_NOT_DEFINED = re.compile(r"ReferenceError: '?([A-Za-z_$][\w$]*)'? is not defined")
_NOT_FUNCTION = re.compile(r"TypeError: (?:(\S+) is )?not a function")
_REPL_POS = re.compile(r"repl\.js:(\d+):(\d+)")
_DECLARED = re.compile(r"Identifier '([^']+)' has already been declared")
_TRAILING_NAME = re.compile(r"([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*$")


def _called_name(message: str, sent: str | None) -> str | None:
    """Name of the method behind a 'not a function' error.

    Older Aside builds print `page.waitForTimeout is not a function`; newer builds print only
    `not a function`, but the `repl.js:LINE:COL` position points at the call's `(`.
    """
    m = _NOT_FUNCTION.search(message)
    if m and m.group(1):
        name = re.split(r"[.\s]", m.group(1).rstrip(")"))[-1]
        return name or None
    pos = _REPL_POS.search(message)
    if not (pos and sent):
        return None
    lines = sent.split("\n")
    line_no, col = int(pos.group(1)), int(pos.group(2))
    if not 1 <= line_no <= len(lines):
        return None
    found = _TRAILING_NAME.search(lines[line_no - 1][: max(col - 1, 0)])
    return found.group(1) if found else None


def explain(message: str, sent: str | None = None) -> str | None:
    """Return an actionable hint for a known Aside REPL failure, or None."""
    inside_page = "AsidePage.evaluate" in message or (
        "ReferenceError" in message and "repl.js" not in message and "<anonymous>:" in message
    )
    m = _NOT_DEFINED.search(message)
    if m:
        name = m.group(1)
        if inside_page and name in REPL_ONLY:
            return (
                f"`{name}` is a REPL helper. Code inside page.evaluate(...) runs in the web page, where it does not exist. "
                "Pass values as the second argument of page.evaluate, and wait inside the page with "
                "`await new Promise(r => setTimeout(r, ms))`."
            )
        if name in PAGE_GLOBALS:
            return (
                f"`{name}` exists only inside the web page; REPL code runs outside it. "
                f"Read it through the page, for example `await page.evaluate(() => document.title)`, "
                "and print the result with console.log or return it."
            )
        if name in NO_NODE:
            return "The Aside REPL has no Node modules, require, or process. Use the REPL globals listed in `aside guide repl`."
        if not inside_page:
            return (
                f"If an earlier call declared `{name}` with const or let, it lived only in that call: run() wraps each call "
                f"in a function. Set `globalThis.{name} = value` to keep a value for later calls."
            )
        return None
    if "not a function" in message:
        name = _called_name(message, sent)
        if name and name in MISSING_API:
            return f"`{name}()` is not available on this object in the Aside REPL. {MISSING_API[name]}"
        if name:
            return f"`{name}` is not a function in the Aside REPL. Run `aside guide repl` for the supported API."
        return None
    m = _DECLARED.search(message)
    if m:
        return (
            f"`{m.group(1)}` was declared by an earlier unwrapped call. Use run(code) with the default wrap=True, "
            "or a new name. Keep values across calls with `globalThis.name = value`."
        )
    return None


# ---------------------------------------------------------------- tab ownership

_owned: dict[str, dict[str, str]] = {}


def owner_key() -> str:
    """The agent session that owns tabs opened here: RLM_SESSION_DIR, else this process."""
    return os.environ.get("RLM_SESSION_DIR") or f"pid:{os.getpid()}"


def _state_dir() -> str:
    return os.environ.get("ASIDE_BROWSER_STATE") or os.path.expanduser("~/.local/state/aside-browser/owners")


def _registry_path(key: str | None = None) -> str:
    """One file per owner in a shared folder, so any kernel on this host can find tabs whose owner has exited."""
    return os.path.join(_state_dir(), hashlib.sha1((key or owner_key()).encode()).hexdigest()[:16] + ".json")


def _legacy_registry_path() -> str | None:
    folder = os.environ.get("RLM_SESSION_DIR")
    return os.path.join(folder, REGISTRY_FILE) if folder else None


def _process_start(pid: int) -> str:
    """The process start time from /proc, so a reused pid does not count as the same kernel. Empty where /proc is missing."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            return fh.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return ""


def _owned_tabs() -> dict[str, str]:
    """targetId -> url opened by this session. Reloaded from the shared folder after a kernel restart."""
    key = owner_key()
    if key not in _owned:
        _owned[key] = {}
        for path in (_registry_path(), _legacy_registry_path()):
            if not path or not os.path.exists(path):
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    data = json.load(fh)
                if data.get("owner") == key and isinstance(data.get("tabs"), dict):
                    _owned[key].update({str(k): str(v) for k, v in data["tabs"].items()})
            except (OSError, ValueError):
                pass
            break
    return _owned[key]


def _save_owned() -> None:
    path = _registry_path()
    tabs_now = _owned_tabs()
    if not tabs_now:
        for old in (path, _legacy_registry_path()):
            if old and os.path.exists(old):
                os.remove(old)
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".aside-tabs-", dir=os.path.dirname(path))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"owner": owner_key(), "host": socket.gethostname(), "pid": os.getpid(), "start": _process_start(os.getpid()), "tabs": tabs_now}, fh)
    os.replace(tmp, path)


def _alive(entry: dict[str, Any]) -> bool:
    """Whether the kernel that wrote a registry entry still runs. An entry from another host or with no pid counts as alive."""
    pid = entry.get("pid")
    if entry.get("host") != socket.gethostname() or not isinstance(pid, int):
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    start = _process_start(pid)
    return not (entry.get("start") and start and start != entry["start"])


def _remember(target_ids: list[str], url: str = "") -> None:
    owned = _owned_tabs()
    changed = False
    for tid in target_ids:
        if tid and tid not in owned and not tid.startswith(BOX_PREFIX):
            owned[tid] = url
            changed = True
    if changed:
        _save_owned()


def _forget(target_ids: list[str]) -> None:
    owned = _owned_tabs()
    if [owned.pop(tid) for tid in list(target_ids) if tid in owned]:
        _save_owned()


def _strip_opened(text: str) -> tuple[str, list[str]]:
    opened: list[str] = []
    kept = []
    for line in text.split("\n"):
        if line.startswith(_OPENED_MARK):
            try:
                opened.extend(str(t) for t in json.loads(line[len(_OPENED_MARK):]))
            except ValueError:
                pass
        else:
            kept.append(line)
    return "\n".join(kept), opened


_LOOPS_TABS = re.compile(
    r"\bof\s+(?:await\s+)?(?:\[\s*\.\.\.\s*)?(?:tabs\b|\(?\s*await\s+listBrowserTabs\b)"
    r"|\btabs\s*\.\s*(?:forEach|map|filter|slice)\s*\("
)
_CLOSES = re.compile(r"\.close\s*\(|\bcloseTab\s*\(")


def _bulk_close(code: str) -> bool:
    return bool(_LOOPS_TABS.search(code) and _CLOSES.search(code))


# ---------------------------------------------------------------- outside sends

# An email or a vendor ticket reply goes out only with the owner's ok on a For you todo (owner correction c37, 2026-10-10).
_MAIL_HOSTS = re.compile(
    r"^(?:mail\.google\.com|inbox\.google\.com|outlook\.(?:live|office|office365)\.com|mail\.yahoo\.com|(?:app|www)\.fastmail\.com"
    r"|mail\.proton\.me|mail\.naver\.com|mail\.daum\.net|app\.hey\.com|mail\.zoho\.[a-z.]+|(?:www\.)?icloud\.com)$",
    re.I,
)
_TICKET_HOST = re.compile(r"(?:^|[.-])(?:support|helpdesk|help|desk|tickets?|clients?)\.|zendesk\.com$|freshdesk\.com$|intercom\.|helpscout\.|kayako\.com$|zohodesk\.|gorgias\.|atlassian\.net$", re.I)
_TICKET_PATH = re.compile(r"(?:submitticket|viewticket|supporttickets|clientarea)\.php|/tickets?(?:/|$|\?)|/requests?/\d|/support(?:/|$)|/servicedesk/|/contact(?:-us)?(?:/|$|\?)", re.I)
_SOCIAL_HOSTS = re.compile(
    r"(?:^|\.)(?:x\.com|twitter\.com|linkedin\.com|discord\.com|facebook\.com|messenger\.com|instagram\.com|reddit\.com|threads\.net"
    r"|web\.whatsapp\.com|web\.telegram\.org)$",
    re.I,
)
# /settings is the signed-in owner's own account settings (tokens, keys, sudo prompts), which post to no one.
_OWN_GITHUB_PATH = re.compile(r"^/(?:sieu-n|virev-ai|settings)(?:/|$)", re.I)
# GitHub sign-in pages (web login, OAuth authorize, the gh device flow, 2FA): agents finish these themselves (c4, owner 10-14), so they are no social page.
_GITHUB_SIGN_IN_PATH = re.compile(r"^/(?:login|session|sessions)(?:/|$)", re.I)
_URL = re.compile(r"https?://[^\s'\"`)<>]+", re.I)
_LOCAL_HOST = re.compile(r"^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$", re.I)
_MAIL_GLOBAL = re.compile(r"\b(?:gmail|outlook)\s*\.\s*(?:openComposer|openReplyComposer|openThreadDetailsPage|send\w*|reply\w*)\b")
_SITE_SEND = re.compile(r"\b(?:linkedin|imessage|whatsapp|discord|twitter|telegram)\s*\.\s*(?:send\w*|reply\w*|post\w*|tweet\w*|comment\w*|message\w*)\s*\(", re.I)
_WIDGET = re.compile(r"intercom|drift-widget|\bcrisp\b|tawk|hubspot-messages|zendesk.*(?:widget|launcher)|\bzE\b|olark|livechat|freshchat|beacon-container", re.I)
_WIDGET_ACTION = re.compile(r"\.\s*(?:click|tap|fill|type|press|pressSequentially|dispatchEvent|submit)\s*\(")
_ENTER = re.compile(r"""\.\s*press\s*\(\s*(?:[^)]*,\s*)?['"`]Enter['"`]""")
_ACTION = re.compile(r"\.\s*(?:click|tap|dblclick|press|dispatchEvent|requestSubmit|submit)\s*\(|\bkeyboard\s*\.\s*(?:press|down|type)\s*\(")
_SEND_NAME = re.compile(r"""\bSend\b|['"`/^]\s*\^?send\b|aria-label[*^$|~]?=\\?['"]?send|data-tooltip[*^$|~]?=\\?['"]?send|\.T-I\.aoO|보내기|送信""", re.I)
_SEND_KEYS = re.compile(r"(?:Meta|Control|ControlOrMeta|Mod|Cmd|Command)\s*\+\s*Enter", re.I)
_SUBMIT = re.compile(r"""\brequestSubmit\s*\(|\.submit\s*\(|\b(?:Submit|Reply|Post|Add Reply|Update Ticket|Comment|Tweet)\b|btn-?(?:Reply|Submit|Send|Post)|tweetButton|type=\\?['"]?submit|답변|답장|제출""", re.I)
_SEND_INTENT = re.compile(r"\b(?:send|sends|sent|reply|replies|respond|answer|submit|forward|post|tweet|dm)\b|^\s*message\b|보내|답장|회신|제출", re.I)
_MAIL_WORDS = re.compile(
    r"\b(?:e-?mails?|mail|gmail|outlook|inbox|tickets?|support|vendor|helpdesk|linkedin|twitter|tweet|discord|telegram|whatsapp|imessage|sms|text message|kakao\w*|contact form)\b"
    r"|메일|티켓|카톡",
    re.I,
)
_DRAFTING = re.compile(r"\bdraft\s+(?:a|an|the|my|our|your|reply|email|message|response)\b|\bas\s+a\s+draft\b|\bunsent\b", re.I)
_NEGATED = re.compile(r"\b(?:do not|don't|dont|never|without|no)\b|하지\s*마|말고", re.I)
_OWNER_OK_HELP = (
    "An outside send needs the owner's ok first. Draft the message, then add a For you todo on your chat's board "
    "that quotes the draft and the recipient, with choices such as \"Send it\" / \"Not yet\". After the owner approves it, "
    "call again with owner_ok=\"<chat id>/<todo id>\". Reading and drafting stay allowed."
)
_REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", ".."))


def _host_kind(url: str) -> str | None:
    """'mail' for a webmail page, 'ticket' for a support portal or contact form, 'social' for a social or chat site, else None."""
    m = re.match(r"https?://(\[[^\]/]*\]|[^/:?#]+)(?::\d+)?([^?#]*)", url or "", re.I)
    if not m or _LOCAL_HOST.match(m.group(1)):
        return None
    host, path = m.group(1), m.group(2)
    if _MAIL_HOSTS.match(host):
        return "mail"
    if _TICKET_HOST.search(host) or _TICKET_PATH.search(path):
        return "ticket"
    if _SOCIAL_HOSTS.search(host) or (host.lower() == "github.com" and path.count("/") >= 3 and not _OWN_GITHUB_PATH.match(path) and not _GITHUB_SIGN_IN_PATH.match(path)):
        return "social"
    return None


_CLICK_MARK = "__ASIDE_SEND_CLICK__:"
# A mouse call on a tab: page.mouse.click(, tabs[1].mouse.down(. The Aside REPL's mouse methods cannot be wrapped in place (a
# replaced method is called back through the replacement, live probe 2026-10-13), so _repl rewrites these calls instead.
_MOUSE_CALL = re.compile(r"([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[[^\[\]]*\])*?)\s*\.\s*mouse\s*\.\s*(move|click|dblclick|down)\s*\(")
_CLICK_LABEL = {
    "mail": r"^\s*(?:send|보내기|送信)(?![a-z])",
    "other": r"^\s*(?:send|submit|reply|post|comment|tweet|add reply|update ticket|보내기|送信|답장|답변|제출|게시)(?![a-z])",
}
# One line run before the rewritten code. A click by coordinates (page.mouse.click(x, y), the 10-12 GeoNode Intercom send) first
# reads the element under the point and throws when it is Send on a webmail page, Send or Submit on a ticket or social page,
# or a support chat widget's frame. mouse.down checks the point of the last mouse.move.
_CLICK_GUARD = (
    "globalThis.__asideSendClick = (() => { const re = (s) => new RegExp(s, 'i'), R = __PATTERNS__, at = new Map();"
    r"const kind = (u) => { const m = /^https?:\/\/([^\/:?#]+)(?::\d+)?([^?#]*)/i.exec(u || ''); if (!m || re(R.local).test(m[1])) return null;"
    " if (re(R.mail).test(m[1])) return 'mail'; if (re(R.ticketHost).test(m[1]) || re(R.ticketPath).test(m[2])) return 'ticket';"
    " if (re(R.social).test(m[1]) || (m[1].toLowerCase() === 'github.com' && m[2].split('/').length > 3 && !re(R.ownGithub).test(m[2]) && !re(R.githubSignIn).test(m[2]))) return 'social'; return null; };"
    "const check = async (p, x, y) => { const url = p.url(), k = kind(url);"
    " const e = await p.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); if (!el) return null;"
    "  const b = el.closest('button,[role=button],a,input,[role=menuitem]') || el, a = (n) => b.getAttribute(n) || '';"
    "  return {title: document.title, frame: el.tagName === 'IFRAME' ? [el.id, el.name, el.className, el.src, el.title].join(' ') : '',"
    "   label: String(a('aria-label') || a('data-tooltip') || b.value || b.innerText || b.textContent || '').trim().slice(0, 80)}; }, [x, y]).catch(() => null);"
    " if (!e) return; let why = null;"
    " if (e.frame && re(R.widget).test(e.frame)) why = 'it clicks by coordinates in a support chat widget';"
    " else if (k === 'mail' && re(R.mailLabel).test(e.label)) why = 'it clicks Send by coordinates on a webmail page';"
    " else if ((k === 'ticket' || k === 'social') && re(R.label).test(e.label)) why = 'it clicks ' + JSON.stringify(e.label) + ' by coordinates on a ' + (k === 'ticket' ? 'support ticket page or contact form' : 'social or chat site');"
    " if (!why) return; const line = __MARK__ + JSON.stringify({reason: why + ' (' + url + ')', target: [url, e.title, 'clicked ' + JSON.stringify(e.label || e.frame) + ' at (' + x + ', ' + y + ')'].filter(Boolean).join(' | ')});"
    " console.log(line); throw new Error(line); };"
    "return {mouse: (p) => ({"
    " move: async (x, y, o) => { at.set(p, [x, y]); return p.mouse.move(x, y, o); },"
    " click: async (x, y, o) => { await check(p, x, y); return p.mouse.click(x, y, o); },"
    " dblclick: async (x, y, o) => { await check(p, x, y); return p.mouse.dblclick(x, y, o); },"
    " down: async (o) => { const xy = at.get(p); if (xy) await check(p, xy[0], xy[1]); return p.mouse.down(o); }})}; })();"
)


def guard_clicks(code: str) -> str:
    """The code with each tab.mouse call routed through the click check, and the one-line check before it. Code with no mouse call comes back as is."""
    rewritten = _MOUSE_CALL.sub(r"globalThis.__asideSendClick.mouse(\1).\2(", code)
    if rewritten == code:
        return code
    patterns = {
        "local": _LOCAL_HOST.pattern, "mail": _MAIL_HOSTS.pattern, "ticketHost": _TICKET_HOST.pattern, "ticketPath": _TICKET_PATH.pattern,
        "social": _SOCIAL_HOSTS.pattern, "ownGithub": _OWN_GITHUB_PATH.pattern, "githubSignIn": _GITHUB_SIGN_IN_PATH.pattern, "widget": _WIDGET.pattern,
        "mailLabel": _CLICK_LABEL["mail"], "label": _CLICK_LABEL["other"],
    }
    return _CLICK_GUARD.replace("__PATTERNS__", json.dumps(patterns, ensure_ascii=False)).replace("__MARK__", json.dumps(_CLICK_MARK)) + " " + rewritten


def _click_refusals(text: str) -> list[dict[str, str]]:
    """The coordinate clicks the REPL prelude refused, read from the call's output or error text."""
    found, at = {}, text.find(_CLICK_MARK)
    while at != -1:
        try:
            line, _ = json.JSONDecoder().raw_decode(text, at + len(_CLICK_MARK))
            found[json.dumps(line, sort_keys=True)] = line
        except ValueError:
            pass
        at = text.find(_CLICK_MARK, at + 1)
    return [line for line in found.values() if isinstance(line, dict)]


def _sends(code: str) -> bool:
    """Code that could send: a send shortcut, a site skill's send call, an action in a support chat widget, or a click or key press near a Send or Submit name or Enter."""
    if _SEND_KEYS.search(code) or _SITE_SEND.search(code) or (_WIDGET.search(code) and _WIDGET_ACTION.search(code)):
        return True
    return bool(_ACTION.search(code) and (_SEND_NAME.search(code) or _SUBMIT.search(code) or _ENTER.search(code)))


def outside_send(code: str, page_url: str = "") -> str | None:
    """Why this REPL code sends an email, a ticket reply or a message from page_url (the current tab), or None."""
    if not _sends(code):
        return None
    if _SITE_SEND.search(code):
        return "it sends through an Aside site skill (LinkedIn, iMessage, WhatsApp, Discord, X or Telegram)"
    if _WIDGET.search(code) and _WIDGET_ACTION.search(code):
        return "it types or clicks in a support chat widget"
    kinds = {_host_kind(u) for u in [page_url, *_URL.findall(code)]}
    if _MAIL_GLOBAL.search(code):
        kinds.add("mail")
    send_click = bool(_SEND_KEYS.search(code) or _SEND_NAME.search(code))
    if "mail" in kinds and send_click:
        return f"it presses Send on a webmail page ({page_url or 'mail tab'})"
    if "ticket" in kinds:
        return f"it submits or sends on a support ticket page or contact form ({page_url or 'ticket page'})"
    if "social" in kinds:
        return f"it posts or sends on a social or chat site ({page_url or 'social tab'})"
    return None


def outside_send_prompt(prompt: str) -> str | None:
    """Why this Aside agent task asks to send an email or a ticket reply, or None. A negated sentence ("do not send") is skipped."""
    for sentence in re.split(r"(?<=[.!?。])\s+|\n+", prompt or ""):
        if _DRAFTING.search(sentence) and not re.search(r"\bsend\b", sentence, re.I):
            continue
        if _SEND_INTENT.search(sentence) and _MAIL_WORDS.search(sentence) and not _NEGATED.search(sentence):
            return f"the task asks the Aside agent to send: \"{sentence.strip()[:160]}\""
    return None


_CALLS = {"run", "repl", "_repl", "agent"}


def _literal(node: "ast.AST") -> str | None:
    """A string argument as written: a literal, an f-string with its holes as {...}, or a % template's left side."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "{...}" for part in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        return _literal(node.left)
    if isinstance(node, ast.Name):
        return None
    return None


def cell_sends(cell: str, page_url: str = "") -> str | None:
    """Why an ipython cell's aside_browser calls send, judged as run() and agent() judge them, or None. The send log backfill reads old cells with it.

    Only the code passed to aside_browser(...), .run, .repl, ._repl or .agent counts, so a cell that only quotes send code in a test or a note is no send.
    A call that passes owner_ok counts too, the way run() logs it.
    A string held in a variable is looked up when the cell assigns it a literal.
    """
    try:
        tree = compile(cell, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except (SyntaxError, ValueError):
        return None
    names: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            text = _literal(node.value)
            if text is not None:
                names[node.targets[0].id] = text
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "aside_browser":
            kind = "run"
        elif isinstance(func, ast.Attribute) and func.attr in _CALLS and isinstance(func.value, ast.Name) and func.value.id == "aside_browser":
            kind = func.attr
        else:
            continue
        arg = node.args[0]
        code = names.get(arg.id) if isinstance(arg, ast.Name) else _literal(arg)
        reason = None if code is None else outside_send_prompt(code) if kind == "agent" else outside_send(code, page_url)
        if reason:
            return reason
        if any(k.arg == "owner_ok" and not (isinstance(k.value, ast.Constant) and k.value.value is None) for k in node.keywords):
            # The caller says it sends, though the page check cannot tell (a coordinate click in an Intercom frame).
            return "the call passed owner_ok, so its caller counted it as a send"
    return None


def check_owner_ok(token: str) -> str | None:
    """None when `<chat id>/<todo id>` is an approved For you todo, else the reason it is not (components/user-history/src/owner-ok.ts)."""
    script = os.path.join(_REPO, "components", "user-history", "src", "owner-ok.ts")
    if not os.path.exists(script):
        return f"the owner-ok check is missing at {script}"
    try:
        proc = subprocess.run(
            ["node", "--import", "tsx", script, token],
            cwd=os.path.dirname(os.path.dirname(script)),
            capture_output=True, text=True, timeout=30,
        )
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        return f"the owner-ok check failed: {exc}"
    return None if result.get("ok") is True else str(result.get("reason") or "not approved")


def send_log_path() -> str:
    """The send log that every send guard layer writes (components/global-rules/send-log.ts sendLogPath, same order)."""
    if os.environ.get("GLOBAL_RULES_SEND_LOG"):
        return os.environ["GLOBAL_RULES_SEND_LOG"]
    if os.environ.get("AGENT_CHAT_DATA_DIR"):
        return os.path.join(os.environ["AGENT_CHAT_DATA_DIR"], "sends.jsonl")
    if os.environ.get("GLOBAL_RULES_LOG"):
        return os.path.join(os.path.dirname(os.environ["GLOBAL_RULES_LOG"]), "sends.jsonl")
    return os.path.join(os.path.expanduser("~"), ".prime", "agent", "browser-chat", "sends.jsonl")


def _record_send(decision: str, reason: str, target: str, owner_ok: str | None) -> None:
    """One line in the send log (c37) for a send this skill allowed or refused. A log that cannot be written never stops the call."""
    parts = os.path.normpath(os.environ.get("RLM_SESSION_DIR", "")).split(os.sep)
    rest = parts[parts.index("session-artifacts") + 1:] if "session-artifacts" in parts else []
    line = {
        "decision": decision, "layer": "aside-browser", "chat": rest[0] if rest else None,
        "session": "/".join(rest) if rest else (os.environ.get("RLM_SESSION_DIR") or None),
        "target": target[:600], "reason": reason[:300], "ownerOk": owner_ok,
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    try:
        path = send_log_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")
    except OSError:
        pass


def _refuse_send(reason: str, owner_ok: str | None, target: str = "") -> None:
    if owner_ok:
        why = check_owner_ok(owner_ok)
        if why is None:
            _record_send("allowed", reason, target, owner_ok)
            return
        _record_send("refused", reason, target, owner_ok)
        raise AsideError(f"Refused: {reason}, and owner_ok={owner_ok!r} is not an approved For you todo: {why}", _OWNER_OK_HELP)
    _record_send("refused", reason, target, owner_ok)
    raise AsideError(f"Refused: {reason}.", _OWNER_OK_HELP)


_PAGE_JS = (
    "const p = (typeof page !== 'undefined' && page) ? page : null;"
    "const info = p ? await p.evaluate(() => ({t: document.title, to: [...new Set([...document.querySelectorAll('[email]')].map(e => e.getAttribute('email')))]})).catch(() => ({})) : {};"
    "console.log(JSON.stringify({u: p ? p.url() : '', t: info.t || '', to: info.to || []}))"
)


async def _page(browser: str | None = None) -> dict[str, Any]:
    """The current tab's URL, title and the email addresses it shows (a Gmail thread's recipients), for the send check and the send log."""
    try:
        text = await _repl(_scoped(_PAGE_JS), "send check", browser=browser)
    except AsideError:
        return {}
    for line in reversed(text.splitlines()):
        if line.startswith("{"):
            try:
                found = json.loads(line)
            except ValueError:
                return {}
            return found if isinstance(found, dict) else {}
    return {}


def _page_target(info: dict[str, Any]) -> str:
    to = [str(e) for e in info.get("to") or [] if e]
    return " | ".join(part for part in (str(info.get("u") or ""), str(info.get("t") or ""), f"to {', '.join(to)}" if to else "") if part)


# ---------------------------------------------------------------- transport


_STALE_SERVER = ("REPL session not found", "Connection closed")


async def _call(tool: str, arguments: dict[str, Any]) -> str:
    from rlm import mcp

    try:
        try:
            result = await mcp.call_tool(SERVER, tool, arguments)
        except Exception as exc:
            # A restart of Aside.app drops the MCP server's REPL session ("REPL session not found"),
            # and a dead `aside mcp` process gives "Connection closed". A fresh server fixes both
            # (seen 2026-10-18 after Aside was restarted to free RAM), so reload once and retry.
            if isinstance(exc, KeyError) or not any(s in str(exc) for s in _STALE_SERVER):
                raise
            await mcp.reload(SERVER)
            result = await mcp.call_tool(SERVER, tool, arguments)
    except KeyError:
        return await _cli_fallback(tool, arguments)
    except Exception as exc:  # McpToolError and transport errors
        raise AsideError(str(exc)) from exc
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        return "\n".join(str(block.get("text", block)) if isinstance(block, dict) else str(block) for block in result)
    return json.dumps(result)


async def _cli_fallback(tool: str, arguments: dict[str, Any]) -> str:
    if tool == "repl":
        argv = [CLI, "repl", arguments["code"]]
    elif tool == "exec":
        argv = [CLI, "exec", arguments["prompt"]]
        if arguments.get("session_id"):
            argv = [CLI, "session", "resume", arguments["session_id"], arguments["prompt"]]
    elif tool == "memory_search":
        argv = [CLI, "memory", "search", " ".join(arguments["queries"]), "--json"]
    else:
        raise AsideError(f"no CLI fallback for tool {tool!r}")
    proc = await asyncio.to_thread(subprocess.run, argv, capture_output=True, text=True, timeout=180)
    out = _ANSI.sub("", (proc.stdout or "") + (proc.stderr or ""))
    status_lines = [line for line in out.splitlines() if _STATUS.match(line)]
    text = "\n".join(line for line in out.splitlines() if not _STATUS.match(line)).strip()
    failed = proc.returncode != 0 or any(line.startswith("[error") for line in status_lines)
    if failed:
        raise AsideError(f"aside CLI exit {proc.returncode}: {text[-2000:]}")
    return "[aside-browser fallback] host has no `aside` MCP server yet; ran one-shot `aside repl` (state does not persist). Run /reload in the TUI.\n" + text


# ---------------------------------------------------------------- box browser

# Hosts where a page shows the owner's own account, so it opens in his Aside window. Every other http(s) page opens in the
# box's own Chrome: at 04:00 to 07:00Z on 2026-10-18 agents made 582 Aside REPL calls from us-metal02, and their open
# tabs all render as visible in his window (visibilityState 'visible' in every tab), while Aside used 70 to 105% of a Mac core.
LOGIN_HOSTS = re.compile(
    r"(?:^|\.)(?:google\.com|youtube\.com|github\.com|gitlab\.com|posthog\.com|geonode\.com|iwebfusion\.net|railway\.(?:com|app)"
    r"|vercel\.com|stripe\.com|cloudflare\.com|convex\.dev|supabase\.com|amazon\.com|aws\.amazon\.com|apple\.com|icloud\.com"
    r"|slack\.com|notion\.so|figma\.com|claude\.ai|anthropic\.com|openai\.com|chatgpt\.com|aside\.com|g2g\.com|impact\.com"
    r"|tailscale\.com|grafana\.net|sentry\.io|linear\.app|atlassian\.net|clerk\.com|kakao\.com|naver\.com|coupang\.com"
    r"|x\.com|twitter\.com|linkedin\.com|discord\.com|facebook\.com|instagram\.com|reddit\.com|threads\.net|bsky\.app)$",
    re.I,
)
_LOGIN_PAGE = re.compile(r"^https?://(?:accounts\.|login\.|auth\.|sso\.)|/(?:log-?in|sign-?in|sign_in|auth|sso|oauth|session)(?:[/?#.]|$)", re.I)


def browser_for(url: str) -> str:
    """'box' for a page that needs none of the owner's logins (our own apps, public pages), else 'aside'."""
    try:
        parts = urlsplit(url or "")
        host = parts.hostname or ""
    except ValueError:
        return "aside"
    if parts.scheme not in ("http", "https") or not host or not box_available() or LOGIN_HOSTS.search(host) or _host_kind(url):
        return "aside"
    return "box"


# The Aside REPL's site skill globals (`aside skills list`), which exist only in Aside.
_SITE_GLOBAL = re.compile(r"\b(?:gmail|outlook|slack|notion|googleDocs|googleSheets|googleSearch|googleAccounts|youtube|linkedin|imessage)\s*\.\s*[A-Za-z_$]")
_OPEN_TAB_URL = re.compile(r"""\bopenTab\s*\(\s*['"`]([^'"`]+)['"`]""")


def _route(code: str) -> str | None:
    """The browser a run() call needs: the one browser_for() picks for an openTab('<url>') in the code, Aside for a site skill global, else None (the current tab's browser)."""
    opened = _OPEN_TAB_URL.search(code)
    if opened:
        return browser_for(opened.group(1))
    return "aside" if _SITE_GLOBAL.search(code) else None


def box_available() -> bool:
    """The box runner works here: not the owner's Mac (Aside is local there), its playwright-core is installed, and ASIDE_BROWSER_BOX is not 0."""
    if os.environ.get("ASIDE_BROWSER_BOX", "1") == "0" or sys.platform == "darwin":
        return False
    return bool(_node()) and os.path.isdir(os.path.join(BOX_DIR, "node_modules", "playwright-core"))


def _node() -> str | None:
    found = shutil.which("node") or os.path.expanduser("~/.local/node/bin/node")
    return found if found and os.path.exists(found) else None


class _BoxRunner:
    """One `node box.mjs` per kernel. It exits, and its tabs close, when the kernel's end of stdin closes."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen[str] | None = None
        self.log = ""
        self.lock = threading.Lock()
        self.next = 0

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self) -> subprocess.Popen[str]:
        node = _node()
        if not node:
            raise AsideError("no node binary for the box browser", "Open the page in Aside with browser='aside'.")
        fd, self.log = tempfile.mkstemp(prefix="aside-box-", suffix=".log")
        try:
            self.proc = subprocess.Popen(
                [node, os.path.join(BOX_DIR, "box.mjs")], cwd=BOX_DIR, text=True, bufsize=1,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=fd,
            )
        finally:
            os.close(fd)
        return self.proc

    def call(self, code: str, timeout: float = 120) -> str:
        with self.lock:
            proc = self.proc if self.running() else self._start()
            self.next += 1
            assert proc.stdin and proc.stdout
            proc.stdin.write(json.dumps({"id": self.next, "code": code}) + "\n")
            proc.stdin.flush()
            while True:
                ready, _, _ = select.select([proc.stdout], [], [], timeout)
                line = proc.stdout.readline() if ready else ""
                if not line:
                    proc.kill()
                    with open(self.log, encoding="utf-8", errors="replace") as fh:
                        tail = fh.read()[-1500:]
                    raise AsideError(f"box browser {'timed out after %ds' % timeout if not ready else 'exited'}: {tail}".strip())
                reply = json.loads(line)
                if reply.get("id") == self.next:
                    break
        if "error" in reply:
            raise AsideError(str(reply["error"]))
        return str(reply.get("out", ""))


_box = _BoxRunner()


async def _box_call(code: str) -> str:
    return await asyncio.to_thread(_box.call, code)


_browser: str | None = None


def _current() -> str:
    """The browser of the last open_tab, attach or routed run(); before any, the box when it works here, else Aside."""
    return _browser or ("box" if box_available() else "aside")


async def _repl(code: str, title: str, owner_ok: str | None = None, plain: str | None = None, browser: str | None = None) -> str:
    """Send code as is to `browser` (default: the browser of the last open_tab or attach). Records tabs reported by the open-tab marker and adds hints to known errors.

    Every REPL call passes the outside send check here; `plain` is the caller's code before wrapping.
    """
    browser = browser or _current()
    approved = False
    if _sends(plain or code) or owner_ok:
        info = await _page(browser)
        reason = outside_send(plain or code, str(info.get("u") or "")) if _sends(plain or code) else None
        if reason:
            _refuse_send(reason, owner_ok, _page_target(info) or (plain or code)[:300])
            approved = True
        elif owner_ok and check_owner_ok(owner_ok) is None:
            # The caller says this call sends, though the page check cannot tell (a coordinate click in an Intercom frame); it still gets a line.
            _record_send("allowed", "the call passed owner_ok, so its caller counted it as a send", _page_target(info) or (plain or code)[:300], owner_ok)
            approved = True
    if not approved:
        code = guard_clicks(code)
    try:
        text = await (_box_call(code) if browser == "box" else _call("repl", {"title": title, "code": code}))
    except AsideError as exc:
        message, opened = _strip_opened(str(exc))
        _remember(opened)
        refused = _click_refusals(message)
        for click in refused:
            _record_send("refused", click.get("reason", ""), click.get("target", ""), owner_ok)
        if refused:
            raise AsideError(f"Refused: {refused[0].get('reason')}.", _OWNER_OK_HELP) from exc.__cause__
        raise AsideError(message, explain(message, code)) from exc.__cause__
    text, opened = _strip_opened(text)
    _remember(opened)
    for click in _click_refusals(text):
        _record_send("refused", click.get("reason", ""), click.get("target", ""), owner_ok)
    return text


async def run(code: str, title: str = "aside repl", wrap: bool = True, force: bool = False, owner_ok: str | None = None) -> str:
    """Run Playwright-style JavaScript in the Aside browser REPL and return its console output.

    Globals: page, tabs, openTab(url), closeTab(tab), listBrowserTabs(),
    attachBrowserTab(targetId), attachActiveBrowserTab(), snapshot(page, {interactive}),
    annotatedScreenshot(page), fetch, fs (sandboxed to the Aside session dir), sleep.
    Print values with console.log(), or `return value` to print it.

    wrap=True (default) runs the code inside an async function: `const`/`let` names are
    local to this call, and tabs the code opens with openTab() become owned by this session.
    Keep a value for later calls with `globalThis.name = value`. wrap=False sends the code
    unchanged into the REPL's persistent top-level scope.
    Code that loops over `tabs` and closes them is refused unless force=True; use
    close_own_tabs(). Code that presses Send on a webmail page or submits on a support ticket page is
    refused unless owner_ok names the owner's approved For you todo as "<chat id>/<todo id>".
    Errors raise AsideError, with a hint for known REPL mistakes. 120 s per call.
    """
    if not force and _bulk_close(code):
        raise AsideError(
            "Refused: this code loops over browser tabs and closes them.",
            "The Aside browser is shared, and `tabs` can hold tabs you attached or other agents opened. "
            "Close your own tabs with `await aside_browser.close_own_tabs()`, or one tab with "
            "`await aside_browser.close_tab(target_id)`. Pass force=True only if the user asked for it.",
        )
    global _browser
    where = _route(code)
    text = await _repl(wrap_code(code) if wrap else code, title, owner_ok=owner_ok, plain=code, browser=where)
    _browser = where or _browser
    return text


repl = run


async def tabs(browser: str | None = None) -> list[dict[str, Any]]:
    """List open tabs as dicts with targetId, active, title, url, owned (opened by this session) and browser ('aside' or 'box').

    browser=None lists the box's own tabs on a Linux box and the Aside tabs on the Mac, so a box session never reads the owner's Aside
    tabs unless it asks with browser='aside' or browser='all'. Box tabs (targetId box-N) belong to this kernel and close with it.
    """
    if browser not in (None, "aside", "box", "all"):
        raise ValueError("browser must be None, 'aside', 'box' or 'all'")
    await _sweep_quietly()
    lister = _scoped(
        "const __tabs = await listBrowserTabs(); console.log(JSON.stringify(__tabs.map(t => ({targetId: t.targetId, active: t.active, title: t.title, url: t.url}))))"
    )
    wanted = {"aside": ("aside",), "box": ("box",), "all": ("aside", "box")}.get(browser or "", ("box",) if box_available() else ("aside",))
    found: list[dict[str, Any]] = []
    owned = _owned_tabs()
    for browser in [b for b in wanted if b == "aside" or _box.running()]:
        text = await _repl(lister, "list tabs", browser=browser)
        line = [l for l in text.splitlines() if l.startswith("[")]
        for tab in json.loads(line[-1]) if line else []:
            tab["owned"] = browser == "box" or tab.get("targetId") in owned
            tab["browser"] = browser
            found.append(tab)
    return found


async def owned_tabs() -> list[dict[str, Any]]:
    """Open tabs that this agent session opened. Forgets owned tabs that are already closed."""
    found = await tabs("all" if _owned_tabs() else None)
    open_ids = {t.get("targetId") for t in found}
    _forget([tid for tid in _owned_tabs() if tid not in open_ids])
    return [t for t in found if t["owned"]]


_BOX_NOTE = (
    "[aside-browser box] Opened in the box's own Chrome, which has none of the owner's logins. "
    "Pass browser='aside' for a page that needs one."
)


async def open_tab(url: str, browser: str | None = None) -> str:
    """Open url in a new tab owned by this session, set it as `page`, return title, final URL and targetId.

    browser=None picks by URL with browser_for(): a page that needs the owner's login opens in his Aside window, every other
    page (our own apps, public pages) in the box's Chrome. Later run(), snapshot() and screenshot() calls use that tab.
    """
    global _browser
    where = browser or browser_for(url)
    if where not in ("aside", "box"):
        raise ValueError("browser must be 'aside' or 'box'")
    await _sweep_quietly()
    text = await _repl(
        _scoped(f"const __p = await openTab({_js_string(url)}); console.log(JSON.stringify({{title: await __p.title(), url: __p.url(), targetId: __p.targetId}}))"),
        f"open {url}",
        browser=where,
    )
    _browser = where
    for line in reversed(text.splitlines()):
        if line.startswith("{") and '"targetId"' in line:
            try:
                info = json.loads(line)
            except ValueError:
                continue
            _remember([info.get("targetId", "")], info.get("url") or url)
            if where == "box" and _LOGIN_PAGE.search(str(info.get("url") or "")) and not _LOGIN_PAGE.search(url):
                text += f"\n[aside-browser hint] The box landed on a sign-in page. Open it in the owner's Aside instead: open_tab({url!r}, browser='aside')."
            break
    return _BOX_NOTE + "\n" + text if where == "box" else text


async def attach(target_id: str | None = None) -> str:
    """Attach an already open tab (by targetId from tabs(), or the active Aside tab) as `page`.

    An attached Aside tab is not owned: close_tab() refuses it unless force=True.
    """
    global _browser
    where = "box" if target_id and target_id.startswith(BOX_PREFIX) else "aside"
    code = (
        f"await attachBrowserTab({_js_string(target_id)});" if target_id else "await attachActiveBrowserTab();"
    ) + " console.log(JSON.stringify({title: await page.title(), url: page.url(), targetId: page.targetId}))"
    text = await _repl(_scoped(code), "attach tab", browser=where)
    _browser = where
    return text


async def snapshot(interactive: bool = True, selector: str | None = None, show_hidden: bool = False) -> str:
    """Accessibility-tree snapshot of `page` with [ref=eN] ids usable as page.locator('eN')."""
    opts: dict[str, Any] = {"interactive": interactive, "showHidden": show_hidden}
    if selector:
        opts["selector"] = selector
    return await _repl(_scoped(f"const __s = await snapshot(page, {json.dumps(opts)}); console.log(__s.tree)"), "snapshot")


async def screenshot(path: str, full_page: bool = False, annotated: bool = False) -> str:
    """Screenshot `page` to a local PNG path (outside the Aside sandbox). Returns the path.

    annotated=True draws ref-id boxes (Aside's annotatedScreenshot) for click targeting.
    """
    if annotated:
        js = "const __shot = await annotatedScreenshot(page); const __buf = Buffer.from(__shot.base64Image, 'base64');"
    else:
        js = f"const __buf = await page.screenshot({{fullPage: {str(full_page).lower()}}});"
    text = await _repl(_scoped(js + f" console.log({_js_string(_B64_MARK)} + __buf.toString('base64'))"), "screenshot")
    line = [l for l in text.splitlines() if l.startswith(_B64_MARK)]
    if not line:
        raise AsideError(f"no screenshot data in REPL output: {text[-500:]}")
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(line[-1][len(_B64_MARK):]))
    return path


async def _close(target_id: str) -> str:
    tid = _js_string(target_id)
    return await _repl(
        _scoped(
            f"const __t = getTabByTargetId({tid}) || await attachBrowserTab({tid}); await closeTab(__t);"
            " console.log('closed', " + tid + ", '- tabs left in this REPL:', tabs.length)"
        ),
        "close tab",
        browser="box" if target_id.startswith(BOX_PREFIX) else "aside",
    )


def _refuse_close(target_id: str) -> AsideError:
    return AsideError(
        f"Refused to close tab {target_id}: this agent session ({owner_key()}) did not open it.",
        "The Aside browser is shared by the user and other agents. Close only tabs you opened "
        "(`await aside_browser.close_own_tabs()`). Pass force=True only if the user asked to close this tab.",
    )


def _json_line(text: str) -> dict[str, Any]:
    line = [l for l in text.splitlines() if l.startswith("{")]
    return json.loads(line[-1]) if line else {}


async def close_tab(target_id: str | None = None, force: bool = False) -> str:
    """Close one tab: target_id, or the current `page`. Refuses a tab this session did not open.

    Tabs count as opened by this session when they came from open_tab() or from openTab() inside
    run(). force=True closes any tab; use it only when the user asked for that tab to close.
    """
    if target_id is not None:
        if not force and target_id not in _owned_tabs() and not target_id.startswith(BOX_PREFIX):
            raise _refuse_close(target_id)
        text = await _close(target_id)
        _forget([target_id])
        return text
    # One REPL call reads the current tab and closes it only when this session owns it, which saves a round trip to the Mac.
    allowed = "true" if force or _current() == "box" else json.dumps(list(_owned_tabs())) + ".includes(__id)"
    found = _json_line(await _repl(
        _scoped(
            f"const __id = page ? page.targetId : null; const __ok = !!__id && {allowed};"
            " if (__ok) await closeTab(getTabByTargetId(__id) || await attachBrowserTab(__id));"
            " console.log(JSON.stringify({targetId: __id, closed: __ok, left: tabs.length}))"
        ),
        "close tab",
    ))
    target_id = found.get("targetId")
    if not target_id:
        raise AsideError("No current `page` in this REPL session, so there is nothing to close.")
    if not found.get("closed"):
        raise _refuse_close(target_id)
    _forget([target_id])
    return f"closed {target_id} - tabs left in this REPL: {found.get('left')}"


async def _close_open(ids: list[str], title: str) -> list[str]:
    """Close those of ids that are still open in Aside, in one REPL call. Returns the closed targetIds."""
    found = _json_line(await _repl(
        _scoped(
            f"const __open = new Set((await listBrowserTabs()).map(t => t.targetId)); const __closed = [];"
            f" for (const __id of {json.dumps(ids)}) {{ if (!__open.has(__id)) continue;"
            " await closeTab(getTabByTargetId(__id) || await attachBrowserTab(__id)); __closed.push(__id); }"
            " console.log(JSON.stringify({closed: __closed}))"
        ),
        title,
        browser="aside",
    ))
    return [str(t) for t in found.get("closed") or []]


async def close_own_tabs() -> list[str]:
    """Close every still-open tab this agent session opened, Aside and box. Returns the closed targetIds."""
    closed: list[str] = []
    if _box.running():
        found = _json_line(await _repl(
            _scoped("const __ids = tabs.map(t => t.targetId); for (const t of [...tabs]) await closeTab(t); console.log(JSON.stringify({closed: __ids}))"),
            "close own box tabs",
            browser="box",
        ))
        closed += [str(t) for t in found.get("closed") or []]
    owned = list(_owned_tabs())
    if owned:
        closed += await _close_open(owned, "close own tabs")
        _forget(owned)
    return closed


async def sweep_stale_tabs() -> list[str]:
    """Close the Aside tabs of agent kernels on this host that have exited, and drop their records. Returns the closed targetIds.

    open_tab() and tabs() run this first, so a tab lives about as long as the kernel that opened it. Tabs the owner opened
    have no record, so the sweep never touches them.
    """
    folder = _state_dir()
    stale: dict[str, list[str]] = {}
    for name in os.listdir(folder) if os.path.isdir(folder) else []:
        path = os.path.join(folder, name)
        if not name.endswith(".json"):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                entry = json.load(fh)
        except (OSError, ValueError):
            continue
        if entry.get("owner") != owner_key() and isinstance(entry.get("tabs"), dict) and not _alive(entry):
            stale[path] = [str(t) for t in entry["tabs"]]
    ids = [t for found in stale.values() for t in found]
    closed = await _close_open(ids, "sweep stale tabs") if ids else []
    for path in stale:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    return closed


async def _sweep_quietly() -> None:
    try:
        await sweep_stale_tabs()
    except AsideError:
        pass


async def agent(prompt: str, session_id: str | None = None, owner_ok: str | None = None) -> str:
    """Delegate a whole browsing task to the Aside agent (its own model, skills, memory, logins).

    Returns the agent's answer with a session_id; pass session_id back to continue that session.
    A task that asks to send an email or a ticket reply is refused unless owner_ok names an approved For you todo.
    """
    reason = outside_send_prompt(prompt)
    if reason:
        _refuse_send(reason, owner_ok, f"aside agent: {prompt[:400]}")
    args: dict[str, Any] = {"prompt": prompt}
    if session_id:
        args["session_id"] = session_id
    return await _call("exec", args)


async def memory_search(*queries: str, max_results: int = 5) -> str:
    """Search Aside's memory (Markdown notes about the user, people, projects, sites)."""
    if not queries:
        raise ValueError("give at least one query")
    return await _call("memory_search", {"queries": list(queries)[:3], "max_results": max_results})

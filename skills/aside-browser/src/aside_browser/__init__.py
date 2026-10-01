"""Drive the user's Aside browser (logged-in tabs) from the Python kernel.

Transport: prime-agent's generic MCP runtime (`rlm.mcp`) -> the `aside` stdio
server declared in ~/.prime/agent/settings.json (`aside mcp`). Each Prime Agent
kernel starts its own `aside mcp` process with one persistent Playwright-style
REPL. If the host has not loaded the `aside` server yet (needs `/reload` or a
new session), every call falls back to the one-shot CLI `aside repl`, which
loses state between calls; the returned text then starts with a
`[aside-browser fallback]` line.

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

import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any

SERVER = "aside"
CLI = os.environ.get("ASIDE_CLI") or shutil.which("aside") or os.path.expanduser("~/.local/bin/aside")
_B64_MARK = "__ASIDE_B64__:"
_OPENED_MARK = "__ASIDE_OPENED__:"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_STATUS = re.compile(r"^\[(ok|error) \| \d+ms\]$")
REGISTRY_FILE = "aside-browser-tabs.json"


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


def _registry_path() -> str | None:
    folder = os.environ.get("RLM_SESSION_DIR")
    return os.path.join(folder, REGISTRY_FILE) if folder else None


def _owned_tabs() -> dict[str, str]:
    """targetId -> url opened by this session. Reloaded from the session folder after a kernel restart."""
    key = owner_key()
    if key not in _owned:
        _owned[key] = {}
        path = _registry_path()
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    data = json.load(fh)
                if data.get("owner") == key and isinstance(data.get("tabs"), dict):
                    _owned[key].update({str(k): str(v) for k, v in data["tabs"].items()})
            except (OSError, ValueError):
                pass
    return _owned[key]


def _save_owned() -> None:
    path = _registry_path()
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".aside-tabs-", dir=os.path.dirname(path))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"owner": owner_key(), "tabs": _owned_tabs()}, fh)
    os.replace(tmp, path)


def _remember(target_ids: list[str], url: str = "") -> None:
    owned = _owned_tabs()
    changed = False
    for tid in target_ids:
        if tid and tid not in owned:
            owned[tid] = url
            changed = True
    if changed:
        _save_owned()


def _forget(target_ids: list[str]) -> None:
    owned = _owned_tabs()
    if any(owned.pop(tid, None) is not None for tid in list(target_ids)):
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


# ---------------------------------------------------------------- transport


async def _call(tool: str, arguments: dict[str, Any]) -> str:
    from rlm import mcp

    try:
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


async def _repl(code: str, title: str) -> str:
    """Send code as is. Records tabs reported by the open-tab marker and adds hints to known errors."""
    try:
        text = await _call("repl", {"title": title, "code": code})
    except AsideError as exc:
        message, opened = _strip_opened(str(exc))
        _remember(opened)
        raise AsideError(message, explain(message, code)) from exc.__cause__
    text, opened = _strip_opened(text)
    _remember(opened)
    return text


async def run(code: str, title: str = "aside repl", wrap: bool = True, force: bool = False) -> str:
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
    close_own_tabs(). Errors raise AsideError, with a hint for known REPL mistakes. 120 s per call.
    """
    if not force and _bulk_close(code):
        raise AsideError(
            "Refused: this code loops over browser tabs and closes them.",
            "The Aside browser is shared, and `tabs` can hold tabs you attached or other agents opened. "
            "Close your own tabs with `await aside_browser.close_own_tabs()`, or one tab with "
            "`await aside_browser.close_tab(target_id)`. Pass force=True only if the user asked for it.",
        )
    return await _repl(wrap_code(code) if wrap else code, title)


repl = run


async def tabs() -> list[dict[str, Any]]:
    """List open Aside browser tabs as dicts with targetId, active, title, url, owned (opened by this session)."""
    text = await _repl(
        _scoped("const __tabs = await listBrowserTabs(); console.log(JSON.stringify(__tabs.map(t => ({targetId: t.targetId, active: t.active, title: t.title, url: t.url}))))"),
        "list tabs",
    )
    line = [l for l in text.splitlines() if l.startswith("[")]
    found = json.loads(line[-1]) if line else []
    owned = _owned_tabs()
    for tab in found:
        tab["owned"] = tab.get("targetId") in owned
    return found


async def owned_tabs() -> list[dict[str, Any]]:
    """Open tabs that this agent session opened. Forgets owned tabs that are already closed."""
    found = await tabs()
    open_ids = {t.get("targetId") for t in found}
    _forget([tid for tid in _owned_tabs() if tid not in open_ids])
    return [t for t in found if t["owned"]]


async def open_tab(url: str) -> str:
    """Open url in a new Aside tab owned by this session, set it as `page`, return title, final URL and targetId."""
    text = await _repl(
        _scoped(f"const __p = await openTab({_js_string(url)}); console.log(JSON.stringify({{title: await __p.title(), url: __p.url(), targetId: __p.targetId}}))"),
        f"open {url}",
    )
    for line in reversed(text.splitlines()):
        if line.startswith("{") and '"targetId"' in line:
            try:
                info = json.loads(line)
            except ValueError:
                continue
            _remember([info.get("targetId", "")], info.get("url") or url)
            break
    return text


async def attach(target_id: str | None = None) -> str:
    """Attach an already open tab (by targetId from tabs(), or the active tab) as `page`.

    An attached tab is not owned: close_tab() refuses it unless force=True.
    """
    code = (
        f"await attachBrowserTab({_js_string(target_id)});" if target_id else "await attachActiveBrowserTab();"
    ) + " console.log(JSON.stringify({title: await page.title(), url: page.url(), targetId: page.targetId}))"
    return await _repl(_scoped(code), "attach tab")


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
    )


async def close_tab(target_id: str | None = None, force: bool = False) -> str:
    """Close one tab: target_id, or the current `page`. Refuses a tab this session did not open.

    Tabs count as opened by this session when they came from open_tab() or from openTab() inside
    run(). force=True closes any tab; use it only when the user asked for that tab to close.
    """
    if target_id is None:
        text = await _repl(_scoped("console.log(JSON.stringify({targetId: page ? page.targetId : null}))"), "current tab")
        line = [l for l in text.splitlines() if l.startswith("{")]
        target_id = json.loads(line[-1]).get("targetId") if line else None
        if not target_id:
            raise AsideError("No current `page` in this REPL session, so there is nothing to close.")
    if not force and target_id not in _owned_tabs():
        raise AsideError(
            f"Refused to close tab {target_id}: this agent session ({owner_key()}) did not open it.",
            "The Aside browser is shared by the user and other agents. Close only tabs you opened "
            "(`await aside_browser.close_own_tabs()`). Pass force=True only if the user asked to close this tab.",
        )
    text = await _close(target_id)
    _forget([target_id])
    return text


async def close_own_tabs() -> list[str]:
    """Close every still-open tab this agent session opened. Returns the closed targetIds."""
    closed = []
    for tab in await owned_tabs():
        await _close(tab["targetId"])
        _forget([tab["targetId"]])
        closed.append(tab["targetId"])
    return closed


async def agent(prompt: str, session_id: str | None = None) -> str:
    """Delegate a whole browsing task to the Aside agent (its own model, skills, memory, logins).

    Returns the agent's answer with a session_id; pass session_id back to continue that session.
    """
    args: dict[str, Any] = {"prompt": prompt}
    if session_id:
        args["session_id"] = session_id
    return await _call("exec", args)


async def memory_search(*queries: str, max_results: int = 5) -> str:
    """Search Aside's memory (Markdown notes about the user, people, projects, sites)."""
    if not queries:
        raise ValueError("give at least one query")
    return await _call("memory_search", {"queries": list(queries)[:3], "max_results": max_results})

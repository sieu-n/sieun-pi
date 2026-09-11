"""Drive the user's Aside browser (logged-in tabs) from the Python kernel.

Transport: prime-agent's generic MCP runtime (`rlm.mcp`) -> the `aside` stdio
server declared in ~/.prime/agent/settings.json (`aside mcp`). The MCP process
keeps one persistent Playwright-style REPL, so `page`, `tabs` and every
`const`/`let` you declare survive between calls until the REPL idles out
(30 min). If the host has not loaded the `aside` server yet (needs `/reload`
or a new session), every call falls back to the one-shot CLI `aside repl`,
which loses state between calls; the returned text then starts with a
`[aside-browser fallback]` line.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
from typing import Any

SERVER = "aside"
CLI = os.environ.get("ASIDE_CLI") or shutil.which("aside") or os.path.expanduser("~/.local/bin/aside")
_B64_MARK = "__ASIDE_B64__:"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_STATUS = re.compile(r"^\[(ok|error) \| \d+ms\]$")


class AsideError(RuntimeError):
    """The Aside REPL raised, or the CLI/MCP transport failed."""


def _js_string(value: str) -> str:
    return json.dumps(value)


def _scoped(js: str) -> str:
    """Block-scope helper JS so its const names do not collide in the persistent REPL scope."""
    return "await (async () => { " + js + " })();"


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


async def run(code: str, title: str = "aside repl") -> str:
    """Run Playwright-style JavaScript in the Aside browser REPL and return its console output.

    Globals: page, tabs, openTab(url), closeTab(tab), listBrowserTabs(),
    attachBrowserTab(targetId), attachActiveBrowserTab(), snapshot(page, {interactive}),
    annotatedScreenshot(page), fetch, fs (sandboxed to the Aside session dir), sleep.
    Print values with console.log(). Errors raise AsideError. 120 s timeout per call.
    """
    return await _call("repl", {"title": title, "code": code})


repl = run


async def tabs() -> list[dict[str, Any]]:
    """List open Aside browser tabs as dicts with targetId, active, title, url."""
    text = await run(
        _scoped("const __tabs = await listBrowserTabs(); console.log(JSON.stringify(__tabs.map(t => ({targetId: t.targetId, active: t.active, title: t.title, url: t.url}))))"),
        title="list tabs",
    )
    line = [l for l in text.splitlines() if l.startswith("[")]
    return json.loads(line[-1]) if line else []


async def open_tab(url: str) -> str:
    """Open url in a new Aside tab, set it as `page`, return title and final URL."""
    return await run(
        _scoped(f"const __p = await openTab({_js_string(url)}); console.log(JSON.stringify({{title: await __p.title(), url: __p.url()}}))"),
        title=f"open {url}",
    )


async def attach(target_id: str | None = None) -> str:
    """Attach an already open tab (by targetId from tabs(), or the active tab) as `page`."""
    code = (
        f"await attachBrowserTab({_js_string(target_id)});" if target_id else "await attachActiveBrowserTab();"
    ) + " console.log(JSON.stringify({title: await page.title(), url: page.url()}))"
    return await run(_scoped(code), title="attach tab")


async def snapshot(interactive: bool = True, selector: str | None = None, show_hidden: bool = False) -> str:
    """Accessibility-tree snapshot of `page` with [ref=eN] ids usable as page.locator('eN')."""
    opts: dict[str, Any] = {"interactive": interactive, "showHidden": show_hidden}
    if selector:
        opts["selector"] = selector
    return await run(_scoped(f"const __s = await snapshot(page, {json.dumps(opts)}); console.log(__s.tree)"), title="snapshot")


async def screenshot(path: str, full_page: bool = False, annotated: bool = False) -> str:
    """Screenshot `page` to a local PNG path (outside the Aside sandbox). Returns the path.

    annotated=True draws ref-id boxes (Aside's annotatedScreenshot) for click targeting.
    """
    if annotated:
        js = "const __shot = await annotatedScreenshot(page); const __buf = Buffer.from(__shot.base64Image, 'base64');"
    else:
        js = f"const __buf = await page.screenshot({{fullPage: {str(full_page).lower()}}});"
    text = await run(_scoped(js + f" console.log({_js_string(_B64_MARK)} + __buf.toString('base64'))"), title="screenshot")
    line = [l for l in text.splitlines() if l.startswith(_B64_MARK)]
    if not line:
        raise AsideError(f"no screenshot data in REPL output: {text[-500:]}")
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(line[-1][len(_B64_MARK):]))
    return path


async def close_tab() -> str:
    """Close the current `page` tab that this REPL opened."""
    return await run("await closeTab(page); console.log('tabs left:', tabs.length)", title="close tab")


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

"""Websearch skill backed by the Virev search API (api.virev.ai)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

_BASE_URL_ENV = "VIREV_API_BASE"
_DEFAULT_BASE_URL = "https://api.virev.ai"
_KEY_ENV = "VIREV_API_KEY"
_AUTH_ENTRY = "virev"

_SETUP_MESSAGE = (
    "Web search is not set up yet: no Virev API key is configured.\n"
    "Tell the user how to enable it:\n"
    "  1. Get an API key (kb_live_...) from the api.virev.ai dashboard.\n"
    "  2. Either set VIREV_API_KEY in the environment, or add to\n"
    '     ~/.prime/agent/auth.json: "virev": {"type": "api_key", "key": "kb_live_..."}\n'
    "Once the key is saved, web search works automatically."
)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _agent_dir() -> Path:
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser()


def _resolve_api_key() -> str:
    # Read auth.json on each call so a key added after kernel start is picked up.
    env_key = os.environ.get(_KEY_ENV, "").strip()
    if env_key:
        return env_key
    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get(_AUTH_ENTRY) if isinstance(auth, dict) else None
        if isinstance(cred, dict) and cred.get("type") == "api_key":
            value = str(cred.get("key") or "").strip()
            if value and not value.startswith("!"):
                return (os.environ.get(value) or value).strip()
    except (OSError, ValueError):
        pass
    return ""


def _format_results(body: dict, query: str) -> str:
    """Format the portal's {data: <DataForSEO envelope>, meta} body into text."""
    sections: list[str] = []
    data = body.get("data") or {}
    tasks = data.get("tasks") or []
    results = (tasks[0].get("result") or []) if tasks else []
    result = results[0] if results else {}
    items = result.get("items") or []

    for item in items:
        title = (item.get("title") or "").strip() or "Untitled"
        lines = [f"Result {item.get('rank_absolute', '?')}: {title}"]
        url = (item.get("url") or "").strip()
        if url:
            lines.append(f"URL: {url}")
        snippet = (item.get("description") or "").strip()
        if snippet:
            lines.append(snippet)
        sections.append("\n".join(lines))

    if not sections:
        return f"No results returned for query: {query}"

    footer: list[str] = []
    se_count = result.get("se_results_count")
    if se_count:
        footer.append(f"engine total: ~{se_count} results")
    meta = body.get("meta") or {}
    if meta.get("cost") is not None:
        footer.append(f"cost: {meta['cost']}")
    if meta.get("balance") is not None:
        footer.append(f"balance left: {meta['balance']}")
    if footer:
        sections.append(" | ".join(footer))

    return "\n\n---\n\n".join(sections)


def _friendly_http_error(status: int, body_text: str, engine: str) -> str:
    try:
        message = json.loads(body_text)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = body_text[:300]
    if status in (401, 403):
        return (
            f"Virev API rejected the key ({status}): {message}\n"
            "Check the key in VIREV_API_KEY / ~/.prime/agent/auth.json (virev entry); "
            "it may be revoked. Get a fresh key from the api.virev.ai dashboard."
        )
    if status == 402:
        return (
            f"Virev API balance is empty ({status}): {message}\n"
            "Top up the balance at api.virev.ai to keep searching."
        )
    if status == 429:
        return (
            f"{engine} is rate-limiting right now ({status}): {message}\n"
            "No charge was taken. Retry in a bit or try engine='bing'."
        )
    return f"Virev search error ({status}): {message}"


async def _ddg_lite(query: str, *, timeout: int, num_results: int) -> str:
    """Keyless fallback: DuckDuckGo Lite POST (GET returns only the form shell)."""
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.post(
                "https://lite.duckduckgo.com/lite/",
                data={"q": query},
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
        if resp.status_code != 200:
            return ""
        import re as _re

        html = resp.text
        # lite markup: <a rel="nofollow" href="URL" class="result-link">TITLE</a>
        # ... <td class="result-snippet">SNIPPET</td>
        links = _re.findall(
            r'<a[^>]+href="(https?://[^"]+)"[^>]*class=[\'"]result-link[\'"][^>]*>(.*?)</a>',
            html,
            _re.S,
        )
        snippets = _re.findall(
            r'<td[^>]*class=[\'"]result-snippet[\'"][^>]*>(.*?)</td>', html, _re.S
        )
        import html as _html

        strip = lambda s: _html.unescape(_re.sub(r"<[^>]+>", "", s)).strip()  # noqa: E731
        sections = []
        for i, (url, title) in enumerate(links[:num_results]):
            lines = [f"Result {i + 1}: {strip(title)}", f"URL: {url}"]
            if i < len(snippets):
                text = strip(snippets[i])
                if text:
                    lines.append(text)
            sections.append("\n".join(lines))
        return "\n\n---\n\n".join(sections)
    except Exception:  # noqa: BLE001 — fallback must never raise
        return ""


async def run(
    query: str,
    *,
    engine: str = "google",
    num_results: int | None = None,
    gl: str | None = None,
    language: str | None = None,
    max_output: int = 8192,
    timeout: int | None = None,
) -> str:
    """Search the web via the Virev API and return formatted organic results.

    Args:
        query: Search query (700 chars max).
        engine: "google" or "bing" (never substituted; a blocked engine is a 429).
        num_results: Organic results to return, 1-100.
        gl: Optional 2-letter country code for localized results.
        language: Optional ISO-639-1 language code.
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        Formatted search results, or a setup/error explanation.
    """
    if engine not in ("google", "bing"):
        return f"Unknown engine '{engine}': use 'google' or 'bing'."

    api_key = _resolve_api_key()
    if not api_key:
        return _SETUP_MESSAGE

    if timeout is None:
        timeout = _env_int("PRIME_AGENT_WEBSEARCH_TIMEOUT", 45)
    if num_results is None:
        num_results = _env_int("PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5)
    if gl is None:
        # The crawler egresses through a residential pool whose exit geo leaks
        # into unlocalised searches; default to US unless the caller overrides.
        gl = os.environ.get("PRIME_AGENT_WEBSEARCH_GL", "us")

    base_url = os.environ.get(_BASE_URL_ENV, "").strip() or _DEFAULT_BASE_URL
    params: dict[str, str] = {"q": query, "depth": str(max(1, min(100, num_results)))}
    if gl:
        params["gl"] = gl
    if language:
        params["language_code"] = language

    async def _search(target_engine: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await client.get(
                f"{base_url}/v1/search/{target_engine}",
                params=params,
                headers={"Authorization": f"Bearer {api_key}"},
            )

    try:
        resp = await _search(engine)
        if engine == "google" and resp.status_code in (429, 502, 504):
            # Google refuses the crawler's exit pool at its IP-reputation wall
            # (429 since the crawler learned to fail fast; 502/504 were the older
            # render-gate and timeout shapes). Bing-over-plain-HTTP serves
            # anti-bot decoy SERPs and does so through a real rendered browser
            # too (verified 2026-08-26), so fall back to DuckDuckGo Lite
            # (keyless, correct results) — explicitly labelled.
            ddg = await _ddg_lite(query, timeout=timeout, num_results=num_results)
            if ddg:
                result = (
                    "NOTE: google is unavailable on the Virev search backend right now "
                    "(the engine refuses the crawler's exit pool; no charge was taken). "
                    "These are DuckDuckGo results instead:\n\n" + ddg
                )
            else:
                result = _friendly_http_error(resp.status_code, resp.text, engine)
        elif resp.status_code != 200:
            result = _friendly_http_error(resp.status_code, resp.text, engine)
        else:
            result = _format_results(resp.json(), query)
    except Exception as e:  # noqa: BLE001 — a search tool must not raise into the agent loop
        result = f"Error searching for '{query}': {type(e).__name__}: {e}"

    output = f'Results for query "{query}":\n\n{result}'

    if len(output) > max_output:
        total = len(output)
        marker = f"\n... [output truncated, {total} chars total] ...\n"
        half = max(0, (max_output - len(marker)) // 2)
        output = output[:half] + marker + output[len(output) - half:]
        if len(output) > max_output:
            output = output[:max_output]

    return output

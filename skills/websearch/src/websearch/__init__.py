"""Websearch skill backed by the Virev Google search API (api.virev.ai)."""

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


def _format_results(body: dict, query: str, num_results: int) -> str:
    """Format the organic items of the portal's {data: <DataForSEO envelope>, meta} body into text.

    The SERP also holds items such as people_also_ask with no title or URL, so only
    organic items with a URL count, up to num_results.
    """
    sections: list[str] = []
    data = body.get("data") or {}
    tasks = data.get("tasks") or []
    results = (tasks[0].get("result") or []) if tasks else []
    result = results[0] if results else {}
    items = [
        item
        for item in result.get("items") or []
        if item.get("type", "organic") == "organic" and (item.get("url") or "").strip()
    ][:num_results]

    for item in items:
        title = (item.get("title") or "").strip() or "Untitled"
        lines = [f"Result {item.get('rank_absolute', '?')}: {title}"]
        lines.append(f"URL: {item['url'].strip()}")
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


def _error_message(body_text: str) -> str:
    try:
        return str(json.loads(body_text)["error"]["message"])
    except (ValueError, KeyError, TypeError):
        return body_text[:300]


def _friendly_http_error(status: int, body_text: str) -> str:
    message = _error_message(body_text)
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
    if status in (429, 502, 504):
        # A 429 is Google refusing the crawler's exits. A 502 or 504 can also be the
        # crawler itself being down: on 2026-10-15 a prod deploy hold stopped it from
        # 09:16Z to 10:24Z and every call came back as 502 "Upstream error".
        return (
            f"Google is unavailable on the Virev search backend right now (HTTP {status}: {message}). "
            "No charge was taken."
        )
    return f"Virev search error ({status}): {message}"


async def run(
    query: str,
    *,
    num_results: int | None = None,
    gl: str | None = None,
    language: str | None = None,
    max_output: int = 8192,
    timeout: int | None = None,
) -> str:
    """Search Google via the Virev API and return formatted organic results.

    Args:
        query: Search query (700 chars max).
        num_results: Organic results to return, 1-100.
        gl: Optional 2-letter country code for localized results.
        language: Optional ISO-639-1 language code.
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        Formatted search results, or a setup/error explanation.
    """
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

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                f"{base_url}/v1/search/google",
                params=params,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if resp.status_code != 200:
            result = _friendly_http_error(resp.status_code, resp.text)
        else:
            result = _format_results(resp.json(), query, max(1, min(100, num_results)))
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

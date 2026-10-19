---
name: websearch
description: "Use when a task needs current web results for a query. Searches Google or Bing through the Virev API, $0.003 per search."
---

# Web search (Virev)

## Setup

Get an API key (`kb_live_...`) from the api.virev.ai dashboard, then do one of these:

- Set `VIREV_API_KEY` in the environment.
- Add `"virev": {"type": "api_key", "key": "kb_live_..."}` to `~/.prime/agent/auth.json`.

A Google search costs $0.003 and a Bing search costs $0.002. The result footer shows the balance left. A 402 means the balance is empty, so top it up at api.virev.ai.

## Usage

Call the prepared `websearch` import in the Python REPL:

```python
print(await websearch("latest Prime Agent release"))
print(await websearch("some query", num_results=10, gl="kr", language="ko"))
```

The call returns one string and never raises, so errors arrive as text. Optional keyword arguments:

- `engine` is `"google"` (default) or `"bing"`.
- `num_results` is 1 to 100, default 5.
- `gl` is a 2-letter country code, default `"us"`, because the crawler's proxy exit country leaks into searches with no country.
- `language` is an ISO-639-1 code.
- `timeout` is in seconds, default 45.
- `max_output` caps the returned characters, default 8192.

## Google refusals and Bing decoys

On a Google 429, 502 or 504, the call returns DuckDuckGo results under a `NOTE:` line that quotes the API's status and message, and takes no charge. A 429 means Google refused the crawler, and a 502 `Upstream error` usually means the crawler itself is down, as during the 2026-10-15 prod deploy hold. The fallback posts to DuckDuckGo Lite and tries the Lite GET when the post gets the 202 throttle page. When both are throttled, the call returns the API error alone.

When the call returns the API error alone, open DuckDuckGo's HTML page in one browser tab with `await aside_browser.open_tab('https://duckduckgo.com/html/?q=<query>&kl=us-en')`, read the `.result a.result__a` links, and decode each link's `uddg=` parameter. On 2026-10-12 a keyword research job ran 31 queries this way at one query every 6 s, and the 32nd got DuckDuckGo's anomaly page. In the same job plain httpx calls got a 429 from Brave search and a 403 from Mojeek.

Do not use `engine="bing"`, because Bing serves decoy results that look valid but do not match the query (checked 2026-08-26). The 429 error text still says "try engine='bing'", so ignore that hint.

---
name: websearch
description: "Use when a task needs current web results for a query. Searches Google through the Virev API, $0.003 per search."
---

# Web search (Virev)

## Setup

Get an API key (`kb_live_...`) from the api.virev.ai dashboard, then do one of these:

- Set `VIREV_API_KEY` in the environment.
- Add `"virev": {"type": "api_key", "key": "kb_live_..."}` to `~/.prime/agent/auth.json`.

A search costs $0.003. The result footer shows the balance left. A 402 means the balance is empty, so top it up at api.virev.ai.

## Usage

Call the prepared `websearch` import in the Python REPL:

```python
print(await websearch("latest Prime Agent release"))
print(await websearch("some query", num_results=10, gl="kr", language="ko"))
```

The call returns one string and never raises, so errors arrive as text. Optional keyword arguments:

- `num_results` is 1 to 100, default 5.
- `gl` is a 2-letter country code, default `"us"`, because the crawler's proxy exit country leaks into searches with no country.
- `language` is an ISO-639-1 code.
- `timeout` is in seconds, default 45.
- `max_output` caps the returned characters, default 8192.

## When Google is down

Every call goes to Google on `/v1/search/google`, with no other provider behind it. On a 429, 502 or 504 the call returns the API's status and message as `Google is unavailable on the Virev search backend right now (HTTP <status>: <message>). No charge was taken.` A 429 means Google refused the crawler, and a 502 `Upstream error` usually means the crawler itself is down, as during the 2026-10-15 prod deploy hold. Retry the search a few minutes later.

---
name: websearch
description: "Use when a task needs current web results for a query. Searches Google or Bing through the Virev API, $0.003 per search."
---

# Web search (Virev)

## Setup

Get an API key (`kb_live_...`) from the api.virev.ai dashboard. Then do one of these:

- Set `VIREV_API_KEY` in the environment.
- Add `"virev": {"type": "api_key", "key": "kb_live_..."}` to `~/.prime/agent/auth.json`.

Each Google search costs $0.003 and each Bing search costs $0.002. The result footer shows the balance left. A 402 means the balance is empty, so top it up at api.virev.ai.

## Usage

Call the prepared `websearch` import in the Python REPL:

```python
print(await websearch("latest Prime Agent release"))
print(await websearch("some query", num_results=10, gl="kr", language="ko"))
```

The call returns one string and never raises. Optional keyword arguments:

- `engine` is `"google"` (default) or `"bing"`.
- `num_results` is 1 to 100, default 5.
- `gl` is a 2-letter country code, default `"us"`.
- `language` is an ISO-639-1 code.
- `timeout` is in seconds, default 45.
- `max_output` caps the returned characters, default 8192.

Google often refuses the crawler. On a Google 429, 502, or 504, the call returns DuckDuckGo results under a `NOTE:` line and takes no charge. Do not use `engine="bing"`, because Bing serves decoy results that look valid but do not match the query.

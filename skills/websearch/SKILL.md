---
name: websearch
description: "Use when a task needs current web results for a query. Searches Google through the Virev API, $0.003 per search."
---

# Web search (Virev)

## Setup

Get an API key (`kb_live_...`) from the api.virev.ai dashboard, then do one of these:

- Set `VIREV_API_KEY` in the environment.
- Add `"virev": {"type": "api_key", "key": "kb_live_..."}` to `~/.prime/agent/auth.json`.

A search costs $0.003, and the result footer shows it. A 402 means the balance is empty, so top it up at api.virev.ai.

Each call submits the search as a job (`mode=job`), reads its status every 3 s and then reads its result. The API answers the submit at once and the search runs in the crawler, so no Vercel function waits out the crawl. On 2026-11-25 the old wait-in-the-request path held prod functions 54.2 hours for this skill's key.

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
- `timeout` bounds the whole job, submit to result, in seconds, default 75, because the crawler ends a Google search at 60 s.
- `max_output` caps the returned characters, default 8192.

## When Google is down

Every call goes to Google on `/v1/search/google`, with no other provider behind it. When a job fails, as a search Google blocked does, the call returns `Google is unavailable on the Virev search backend right now (job failed: <code>). No charge was taken.` On a 429, 502 or 504, or a 503 with the code `upstream_error`, the call returns the API's status and message as `Google is unavailable on the Virev search backend right now (HTTP <status>: <message>). No charge was taken.` A 429 means Google refused the crawler, and a 502 `Upstream error` usually means the crawler itself is down, as during the 2026-10-15 prod deploy hold. A 503 `upstream temporarily unavailable` means the crawler holds every search while its paid proxy is lapsed (owner rule c230, 2026-11-20), and no retry helps until the owner picks a proxy. Retry any other outage a few minutes later.

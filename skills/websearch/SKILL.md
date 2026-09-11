---
name: websearch
description: Search the web via the Virev search API (api.virev.ai /v1/search/google|bing, DataForSEO organic SERP). Takes one query and returns titles, URLs, and snippets. Needs a Virev API key (VIREV_API_KEY env or a "virev" entry in ~/.prime/agent/auth.json); each Google search bills $0.003 to the key's balance.
---

# Web Search (Virev)

Search the web through the Virev API gateway (`api.virev.ai`). This global skill
replaces the bundled Serper-backed websearch skill.

## Setup

Get an API key (`kb_live_...`) from the api.virev.ai dashboard, then either:

- set `VIREV_API_KEY` in the environment, or
- add to `~/.prime/agent/auth.json`: `"virev": {"type": "api_key", "key": "kb_live_..."}`

Each Google search costs $0.003 (Bing $0.002) from the key's balance. The
result footer shows the remaining balance; a 402 means the balance ran out
(top up at api.virev.ai).

## Usage

Call the prepared `websearch` import directly in the IPython kernel:

```python
print(await websearch("latest Prime Agent release"))
print(await websearch("some query", engine="bing", num_results=10))
```

Optional args: `engine` ("google" | "bing"), `num_results` (1-100, default 5),
`gl` (2-letter country, default "us"), `language` (ISO-639-1), `timeout`,
`max_output`. A 429 means the engine is rate-limiting; retry later.

Known backend state (2026-08-26): the crawler renders Google correctly now,
but Google refuses the crawler's exit pool at its IP-reputation wall, so google
requests answer 429 fast (no charge) and this skill falls back to labelled
keyless DuckDuckGo results. Avoid `engine="bing"`: Bing serves anti-bot decoy
SERPs, through a real rendered browser as well as plain HTTP, so its results can
be unrelated to the query while looking well-formed.

# usage-feed

usage-feed sends the token usage of every Prime model call to LGTM, read from the session transcripts, until Prime's own OTLP exporter runs on the box.
Settings > Usage, the sidebar Throughput line and the Skills and tools cache shares read `prime_agent_*` series from LGTM (`components/user-history/src/usage/lgtm.ts`).
Prime's exporter (prime-agent 973cf9c) writes those series, but on 10-19 no box ran a Prime build with it, so LGTM held none and the Usage page read 0.

## What it does

1. At start it notes the size of every transcript in `~/.prime/agent/sessions` and under each RLM child folder in `~/.prime/agent/session-artifacts`, so only calls that end after it starts count.
2. Every 10 s it reads the bytes appended since, and a transcript that appears later from its start.
3. It adds each assistant message's usage to the five counters of Prime's exporter, with the same names and labels plus `feed="transcripts"`.
4. It sends them as cumulative OTLP sums to the box's Alloy on 127.0.0.1:14318, which writes them to the staging estate Prometheus under `job="prime-agent"`.
5. Every minute it asks LGTM whether `prime_agent_calls_total` on its box has a series without `feed="transcripts"`, and when one shows up it writes `handed-off`, exits 0 and does not start again.

A restart of the feed starts new series and skips the calls made while it was down.

## Install, check and turn off

```sh
python3 -B components/usage-feed/feed.py --dry-run --once                  # print the payload, send nothing
python3 -B components/usage-feed/install.py --ref "$(git rev-parse HEAD)"  # launchd com.sieun.usage-feed on the Mac, systemd usage-feed.service on Linux
tail ~/.local/share/usage-feed/feed.log
python3 -B components/usage-feed/install.py uninstall
```

`tests/test_feed.py` checks the offsets, the zero-first export and the handoff.

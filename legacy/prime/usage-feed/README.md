# usage-feed

usage-feed sends the token usage of every Prime model call to prod otel, read from the session transcripts, until Prime's own OTLP exporter runs on the box.
The Agents card's tok/s, the Skills and tools cache shares and the clean-room hour read the `prime_agent.*` counters from prod ClickHouse `otel.otel_metrics_sum` (`legacy/prime/user-history/src/usage/otel.ts`).
Prime's exporter (prime-agent 973cf9c) writes those counters, but on 10-19 no box ran a Prime build with it, so no box sent them.

## What it does

1. At start it notes the size of every transcript in `~/.prime/agent/sessions` and under each RLM child folder in `~/.prime/agent/session-artifacts`, so only calls that end after it starts count.
2. Every 10 s it reads the bytes appended since, and a transcript that appears later from its start.
   It walks the transcript folders once a minute and between walks reads only the files that grew since the walk before, because on 10-29 the walk on every 10 s tick cost the Mac 4.9% of a core for 13,801 transcripts, and the minute walk costs 0.54%.
   So a new transcript, or one that starts to grow again after a quiet minute, is read at the next walk, up to a minute late.
3. It adds each assistant message's usage to the five counters of Prime's exporter, with the same names and labels plus `feed="transcripts"`.
   It also writes `prime_agent.generation.output_tokens` and `prime_agent.generation.seconds` per provider and model with no session label, which the speed column of Settings > Usage reads.
   A session's two counters stop going out 2 min after its last call and come back with its total on its next call, because on 10-23 one feed process sent 4,280 session series every 10 s and the per-model speed query over them took 15 s for 24h.
4. It sends them as cumulative OTLP sums to the box's Alloy on 127.0.0.1:14318, which sends them to the prod collector, so they land in `otel.otel_metrics_sum` with ServiceName `prime-agent`, the tier `shared` and the box in `host.name`, which the Alloy intake sets on every row because the feed sends no `host.name` of its own.
5. Every minute it asks prod otel, through Grafana's `grafana_clickhouse` datasource, whether `prime_agent.calls` on its box has a series without `feed="transcripts"`, and when one shows up it writes `handed-off`, exits 0 and does not start again.

A restart of the feed starts new series and skips the calls made while it was down.

## Install, check and turn off

```sh
python3 -B legacy/prime/usage-feed/feed.py --dry-run --once                  # print the payload, send nothing
python3 -B legacy/prime/usage-feed/install.py --ref "$(git rev-parse HEAD)"  # launchd com.sieun.usage-feed on the Mac, the Komodo container box-sieun-pi-usage-feed-1 on us-metal02
tail ~/.local/share/usage-feed/feed.log
python3 -B legacy/prime/usage-feed/install.py uninstall                       # the Mac only
```

On us-metal02 the `usage-feed` service of the Komodo Stack `box-sieun-pi` (auto-sns-agent `apps/infra/box/compose.sieun-pi.yml`) runs `feed.py` and appends to the same `feed.log`, which harness-feed's tokens reader parses, so the install restarts the container `box-sieun-pi-usage-feed-1`.

`tests/test_feed.py` checks the offsets, the zero-first export and the handoff.

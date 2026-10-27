# usage-feed

usage-feed sends the token usage of every Prime model call to LGTM, read from the session transcripts, until Prime's own OTLP exporter runs on the box.
Settings > Usage, the sidebar Throughput line and the Skills and tools cache shares read `prime_agent_*` series from LGTM (`legacy/prime/user-history/src/usage/lgtm.ts`).
Prime's exporter (prime-agent 973cf9c) writes those series, but on 10-19 no box ran a Prime build with it, so LGTM held none and the Usage page read 0.

## What it does

1. At start it notes the size of every transcript in `~/.prime/agent/sessions` and under each RLM child folder in `~/.prime/agent/session-artifacts`, so only calls that end after it starts count.
2. Every 10 s it reads the bytes appended since, and a transcript that appears later from its start.
3. It adds each assistant message's usage to the five counters of Prime's exporter, with the same names and labels plus `feed="transcripts"`.
   It also writes `prime_agent.generation.output_tokens` and `prime_agent.generation.seconds` per provider and model with no session label, which the speed column of Settings > Usage reads.
   A session's two counters stop going out 2 min after its last call and come back with its total on its next call, because on 10-23 one feed process sent 4,280 session series every 10 s and the per-model speed query over them took 15 s for 24h.
4. It sends them as cumulative OTLP sums to the box's Alloy on 127.0.0.1:14318, which writes them to the staging estate Prometheus under `job="prime-agent"`.
5. Every minute it asks LGTM whether `prime_agent_calls_total` on its box has a series without `feed="transcripts"`, and when one shows up it writes `handed-off`, exits 0 and does not start again.

A restart of the feed starts new series and skips the calls made while it was down.

## Install, check and turn off

```sh
python3 -B legacy/prime/usage-feed/feed.py --dry-run --once                  # print the payload, send nothing
python3 -B legacy/prime/usage-feed/install.py --ref "$(git rev-parse HEAD)"  # launchd com.sieun.usage-feed on the Mac, systemd usage-feed.service on Linux
tail ~/.local/share/usage-feed/feed.log
python3 -B legacy/prime/usage-feed/install.py uninstall
```

`tests/test_feed.py` checks the offsets, the zero-first export and the handoff.

## History before the feed started

Prometheus takes no remote write sample older than its head block, so `backfill.py` writes the usage from before the feed started as TSDB blocks.
The owner asked for it on 10-19 ("history wiped ㅜㅜ can you upload this box and mac historical usage here").

1. `extract` runs on each host, reads every transcript including `sessions-archive`, and writes one line per call id that ended before `--until`.
2. `build` turns the call files into the feed's five counters with `instance="usage-backfill-<box>"` and `feed="backfill"`, as OpenMetrics text cut into 54 h files, and runs `promtool tsdb create-blocks-from openmetrics` on each.
3. `upload` copies the blocks into the staging Prometheus data folder on us-metal01, which loads them at its next block reload, within a minute.

Each counter has a sample 1 ms after and 1 ms before every minute boundary, so `increase()` over a minute, hour or day bucket reads the exact sum of its calls.
A block must not overlap the head block, which holds the last 2 to 3 hours, so the hours just before the seam go in once the head has moved past them.
`--seam <box>=<time>` ends each box's calls where its live feed starts counting. On 10-19 the Mac seam is 16:22:23.802Z, because the live series' first value, 1,651 output tokens, equals the two calls that end there and after, and the us-metal02 seam is 16:22:07Z, the end of its start scan.
The staging Prometheus keeps 90 days (auto-sns-agent `apps/infra/metal/compose.staging.yml`), and a block older than the retention is deleted at the next reload.

```sh
python3 -B legacy/prime/usage-feed/backfill.py extract --until 2026-10-19T17:00Z --out calls-<box>.jsonl.gz
python3 -B legacy/prime/usage-feed/backfill.py build --calls us-metal02=calls-us-metal02.jsonl.gz --calls mbp=calls-mbp.jsonl.gz \
  --since 2026-10-05T00:00Z --until 2026-10-19T16:00Z --out out --promtool <promtool 3.8.0>
python3 -B legacy/prime/usage-feed/backfill.py build ... --since 2026-10-19T16:00Z --until 2026-10-19T16:23Z \
  --seam us-metal02=2026-10-19T16:22:07Z --seam mbp=2026-10-19T16:22:23.802Z --out out-seam
python3 -B legacy/prime/usage-feed/backfill.py upload out
```

`tests/test_backfill.py` checks the minute samples and the call id dedupe.

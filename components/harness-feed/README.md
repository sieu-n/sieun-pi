# harness-feed

harness-feed sends the coding harness's health to LGTM as OTLP metrics, every 30 s, from each box. Grafana draws them on the "Coding harness health" board (https://obs.virev.ai/d/harness-health/coding-harness-health), whose JSON lives in auto-sns-agent at `apps/infra/grafana/dashboards/estate/68-harness-health.json`.
The owner asked for it on 10-19 (AI harness chat, msgs mvfhd7q5 and mvfhfzby): every number the AI harness chat tracks, and every number and chart the :5182 chat app shows, goes into OTEL with a Grafana board.

## What it does

1. `feed.ts` runs every reader in `readers/` at once, every 30 s, and posts one OTLP/HTTP JSON body to the box's Alloy on 127.0.0.1:14318.
2. Alloy writes the series to the staging Prometheus (Grafana datasource `estate_prometheus_stg`) with `job="harness"` and `box`.
3. Each reader returns gauges, or counters for sources that are cumulative already, with low-cardinality labels such as `chat`, `kind`, `account` and `host`. Top-N holders go out as separate series with a `rank` label.
4. Readers of the chat's own files (`~/.prime/agent/browser-chat`) return nothing unless `instance.json` names a live pid, so only the chat host sends them.
5. Every reader reports `harness_feed_reader_ok` and `harness_feed_reader_duration_seconds`, and the feed reports its own CPU per round and RSS.

| Reader | What it reads |
|---|---|
| tokens | usage-feed health, and cost and tokens per chat from the chat's session copies. Token counters themselves come from `components/usage-feed`. |
| chat-health | d7's clean minutes (whole-system.ts `measure`, ported), holds, hung calls, idle agent memory, agents by state, main-thread stalls and daemon call latency. |
| delivery | The agent and owner outboxes, the daemon's queued input and outside sends (c37). |
| pool | `pi-pool snapshot --json` through hookd, the queue, `turnHistory()` over pi-pool.log, and the sidebar meters from `pool-meter.ts`. |
| duties | Duty runs, check-ins, plans and goals per chat, d9's chat-system run and the daily tool check. |
| alerts-releases | The alert bridge, held resumes, wakes, chat releases, the brief version, the Prime daemon, prime-relay and the Tools page checks (`tool-checks.json`). |
| memory-mac | `host-stats.ts` (Settings > Hosts), PSI, workers, OOM kills, earlyoom kills from the journal, swap, zswap, oom_score_adj, the memory sysctls, heavy run scopes and Chrome for Testing on the Mac. |
| messaging | Messages between agents: sent, bundled, delivered, dropped and refused by reason, the backlog per session, send-to-read time and runs to drain a backlog, from the outboxes, service.log, agent.jsonl, pi-pool runs and the daemon list copies. |
| jobs | Jobs running, queued and parked on an account, cut, resumed, not resumed and deleted, and the wait before a job's first turn, from pi-pool turns.json and pi-pool.log, pool-held.json, service.log, job-cancels.json and the RLM ledger. |
| latency | Prime's own latency on every box: one daemon hello probe a round, call time by method and 30 s timeouts by caller from service.log, every Prime call's time and outcome by method from prime-calls.jsonl and the supervisor's own `logs/daemon.sock.<hash8>.calls.jsonl` with its `.old` copy, the supervisor's main-thread CPU and supervisor and worker restarts from the daemon log. |

A reader reuses the app's own function where plain node can load it (node 26 strips TS types, so a file with constructor parameter properties cannot load). Where it cannot, the reader copies the smallest parse step and names the source.

## Run, test and install

```sh
node components/harness-feed/feed.ts --dry-run --once [--only pool,tokens]   # print one round, send nothing
node --test components/harness-feed/test/                                    # every reader's tests
node components/harness-feed/install.mjs --ref "$(git rev-parse HEAD)"       # systemd harness-feed.service on Linux, launchd com.sieun.harness-feed on the Mac
tail ~/.local/share/harness-feed/feed.log
node components/harness-feed/install.mjs uninstall
```

The install unpacks `components/harness-feed`, `components/prime-relay` and `components/user-history/src` from the commit into `~/.local/share/harness-feed/release-<sha7>` and points `current` at it, so a checkout change does not alter the running copy.
On 10-19 the whole feed used about 0.03 core on us-metal02 in steady state, measured over 199 s with systemd's CPUUsageNSec, and about 200 MB of memory.

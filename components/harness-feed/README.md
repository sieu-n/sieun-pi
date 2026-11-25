# harness-feed

harness-feed sends the coding harness's health to prod otel as OTLP metrics, every 30 s, from each box. Grafana draws them on the "Coding harness health" board (https://obs.virev.ai/d/harness-health/coding-harness-health), whose JSON lives in auto-sns-agent at `apps/infra/grafana/dashboards/estate/68-harness-health.json`.
The owner asked for it on 10-19 (AI harness chat, msgs mvfhd7q5 and mvfhfzby): every number the AI harness chat tracks, and every number and chart the :5182 chat app shows, goes into OTEL with a Grafana board.

## What it does

1. `feed.ts` runs every reader in `readers/` at once, every 30 s, and posts one OTLP/HTTP JSON body to the box's Alloy on 127.0.0.1:14318.
2. Alloy sends them to the prod collector, which writes them to prod ClickHouse `otel.otel_metrics_gauge` and `otel.otel_metrics_sum` under their dotted OTLP names, with ServiceName `harness`, the tier `shared` and the box in `host.name`.
3. Each reader returns gauges, or counters for sources that are cumulative already, with low-cardinality labels such as `chat`, `kind`, `account` and `host`. Top-N holders go out as separate series with a `rank` label.
4. Readers of the chat's own files (`~/.prime/agent/browser-chat`) return nothing unless `instance.json` names a live pid, so only the chat host sends them.
5. Every reader reports `harness_feed_reader_ok` and `harness_feed_reader_duration_seconds`, and the feed reports its own CPU per round and RSS.
6. The feed sends one sample per series a round and keeps the first. It counts each repeat a reader sent in `harness_feed_repeated_samples` by metric, because Prometheus answers a second sample of one series at one time with a 400 that drops Alloy's whole batch of 500, the box's node and cAdvisor series too.

| Reader | What it reads |
|---|---|
| tokens | usage-feed health, and cost and tokens per chat from the chat's session copies. Token counters themselves come from `legacy/prime/usage-feed`. |
| chat-health | d7's clean minutes (whole-system.ts `measure`, ported), holds, hung calls, idle agent memory, agents by state, main-thread stalls and daemon call latency. |
| delivery | The agent and owner outboxes, the daemon's queued input and outside sends (c37). |
| pool | `pi-pool snapshot --json` through hookd, the queue, `turnHistory()` over pi-pool.log, and the sidebar meters from `pool-meter.ts`. It also sends `harness_pool_account_public`, which labels each account with its number in pi-pool's add order and its plan, so auto-sns-agent's public `/sieun/limits` page joins on it and shows accounts by number with no email. |
| duties | Duty runs, check-ins, plans and goals per chat, d9's chat-system run and the daily tool check. |
| alerts-releases | The alert bridge, held resumes, wakes, chat releases, the brief version, the Prime daemon, prime-relay and the Tools page checks (`tool-checks.json`). On every box it also counts the sessions the daemon holds loaded, from one `list` a round, and the sessions Prime should hold loaded or restore, from its pending update recoveries, a prepared update manifest, recovering worker descriptors and a running update's plan. Grafana rule `devbox-prime-daemon-empty` in auto-sns-agent pages ops guy when the daemon is up with 0 loaded and some expected for 5 min. |
| memory-mac | `host-stats.ts` (Settings > Hosts), PSI, workers, OOM kills, earlyoom kills from the journal, swap, zswap, oom_score_adj, the memory sysctls, heavy run scopes and Chrome for Testing on the Mac. |
| messaging | Messages between agents: sent, bundled, delivered, dropped and refused by reason, the backlog per session, send-to-read time and runs to drain a backlog, from the outboxes, service.log, agent.jsonl, pi-pool runs and the daemon list copies. |
| jobs | Jobs running, queued and parked on an account, cut, resumed, not resumed and deleted, and the wait before a job's first turn, from pi-pool turns.json and pi-pool.log, pool-held.json, service.log, job-cancels.json and the RLM ledger. |
| latency | Prime's own latency on every box: one daemon hello probe a round, call time by method and 30 s timeouts by caller from service.log, every Prime call's time and outcome by method from prime-calls.jsonl and the supervisor's own `logs/daemon.sock.<hash8>.calls.jsonl` with its `.old` copy, the supervisor's main-thread CPU and supervisor and worker restarts from the daemon log. |

The service runs feed.ts as `node --import tsx` with the sieun-pi checkout as its working directory on both boxes, because the user-history files its readers import use constructor parameter properties, which node 26's type stripping refuses. The install imports the release with that same command line before it swaps `current`, and on the Mac it writes it into the launchd plist. A reader reuses the app's own function, and copies the smallest parse step and names the source only when the app's module cannot load in the feed.

## Run, test and install

```sh
node components/harness-feed/feed.ts --dry-run --once [--only pool,tokens]   # print one round, send nothing
node --test components/harness-feed/test/                                    # every reader's tests
node components/harness-feed/install.mjs --ref "$(git rev-parse HEAD)"       # the Komodo container box-sieun-pi-harness-feed-1 on us-metal02, launchd com.sieun.harness-feed on the Mac
docker logs --tail 20 box-sieun-pi-harness-feed-1                            # its log on us-metal02; ~/.local/share/harness-feed/feed.log on the Mac
node components/harness-feed/install.mjs uninstall                           # the Mac only
```

The install unpacks `components/harness-feed`, `components/prime-relay` and `legacy/prime/user-history/src` from the commit into `~/.local/share/harness-feed/release-<sha7>` and points `current` at it, so a checkout change does not alter the running copy.
Before the swap it imports the release's `feed.ts` module graph with the service's loader, plus the modules the duties reader loads lazily, and on a failed import it prints node's error and exits 1 with `current` and the service untouched. On 11-25 release 39923ec lacked `apps/chat`, which `store-sums.ts` imported, and the feed was down for 16 s until a rollback.
On us-metal02 the `harness-feed` service of the Komodo Stack `box-sieun-pi` (auto-sns-agent `apps/infra/box/compose.sieun-pi.yml`) runs `current`, so the install restarts the container `box-sieun-pi-harness-feed-1`.
On 10-19 the whole feed used about 0.03 core on us-metal02 in steady state, measured over 199 s with systemd's CPUUsageNSec when it ran as a unit, and about 200 MB of memory.

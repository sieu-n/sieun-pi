# sieun-pi on a Linux box

These units run Prime Agent 0.9.8, the browser chat and the wiki as one Linux user under systemd, the way launchd runs them on the Mac.
They were written for user `sieun` (uid 1001) on us-metal02, where root works through `ssh root@localhost` because sudo is denied.
Since 10-18 at 07:52Z no slice or unit on the box has a memory or CPU limit, reservation, pin or weight, and since 08:45Z neither do the CI units and box timers (owner rule c107), except the memory and CPU layers below. `setup-host.sh` sets none (0214798cd).
Before that, a 40G and then a 69G cap on `user-1001.slice` OOM-killed `auto-sns-dev-pm2.service` at 05:55:35Z on 10-18 while the host had over 130 GiB free.
The chat listens on 127.0.0.1:5182 and the wiki on 127.0.0.1:5176; Tailscale Serve is the only way in.

| Unit | What it runs |
| --- | --- |
| `prime-agent-daemon.service` | The Prime Agent daemon on `/tmp/prime-agent-<uid>/daemon.sock`, with the agent workers under it, started and updated through `prime-agent-daemon-ctl`. |
| `sieun-pi-chat.service` | The chat from `~/.local/share/sieun-pi-chat/current`, the release folder that `scripts/release-chat.mjs` builds. |
| `prime-agent-watchdog.timer` | One cycle of the watchdog every 10 minutes, as `com.sieun.prime-agent-watchdog` does on the Mac. `components/watchdog/install.py` installs the code and both units. |
| `auto-sns-dev-pm2.service` | The auto-sns-agent pm2 daemon (`PM2_HOME=.cache/pm2-dev`) with every dev server in `scripts/dev/dev-apps.cjs`, as launchd `mac-pm2-boot` and `mac-pm2-keep` keep it on the Mac. Its `OOMPolicy=continue` lets pm2 restart only the app whose process the kernel OOM killer took, where the default policy stopped the unit and restarted all 8 apps on 10-18 at 05:55Z. |
| `llm-wiki.service` | The one wiki server for every box, `pnpm run dev` in the auto-sns-agent checkout's `apps/llm-wiki` on 127.0.0.1:5176. It is not in the pm2 dev stack: since auto-sns-agent a6b71cc0bf, `dev-apps.cjs` has no llm-wiki entry, so `pnpm dev` no longer starts it. |
| `box-devserver-heal.service`, `box-pm2-keep.timer` | Box copies of the Mac's `mac-devserver-heal` and `mac-pm2-keep` in `~/.local/share/box-devserver-heal`: restart a hung dev server, refill an empty daemon, and `pm2 save` when the app list changes. |
| `wiki-box-commit.timer` | `wiki-box-commit.mjs` every 5 minutes on the wiki host, which commits the wiki pages written there onto the box's own `sieun/dev`, the tip. |
| `ci-cache.service`, `ci-head-fetch.timer` | The one GitHub Actions poller for auto-sns-agent, `scripts/dev/ci-cache.mjs poll` run from the head export of `origin/sieun/dev` through `run-from-head.mjs --follow-head`, which writes `~/.cache/virev/ci-runs.json` for `ci-run-status`, the gh shim and `board.wake(run=)`. The timer fetches `origin/sieun/dev` every 5 minutes so the poller follows the pushed head. |
| `ci-monitor.timer` | `scripts/dev/ci-monitor.mjs run` every 10 minutes through `run-from-head.mjs`, which writes `snapshot.md`, `history.jsonl`, `state.json` and `dashboard/` in the wiki's `sessions/2026/10/08/0624-ci-access-monitor/logs` for `/playground/ci` and the VP of CI duties. It replaced the Mac's launchd `ai.virev.ci-monitor` on 2026-10-18 at 06:16Z. |
| `secrets-watch.timer` | The secrets check every 15 minutes from the `sessions/2026/10/14/1121-secrets-self-heal/a/run` copy, with its state in `~/.cache/virev/secrets-watch`. It replaced the Mac's launchd `ai.virev.secrets-watch` on 2026-10-18 at 06:23Z. |
| `codex-pool-auth.timer` | Writes `~/.codex/auth.json` from a pi-pool Codex account every 15 minutes, so the codex CLI uses the pool's live token (see the codex line below). |
| `prime-sync.timer` | One run of `components/prime-sync` every minute, which keeps skills, `AGENTS.md`, shared settings, harness entries and the corrections ledger equal to every other box's. |

The daemon has its own unit, so a chat restart never stops a running agent, and the chat unit sets `SIEUN_PI_CHAT_START_DAEMON=0` so the chat never starts a daemon in its own cgroup.
The chat unit sets `KillMode=mixed`, so a stop sends SIGTERM to the chat alone and SIGKILL to the helpers it left, such as `resume_paused.py` or `ci-run-status`, once the chat has exited.
Under `KillMode=process` each stop left those helpers in the unit, as pids 2829488 (python3) and 2831540 (node) at the 10-18 05:53Z stop and pid 3458523 (python3) at the 06:07Z stop.
The daemon unit sets `KillMode=process` too, so a daemon restart signals only the daemon and the new one adopts the running workers. On 10-18 at 03:38Z a restart under the default `control-group` mode sent SIGTERM to every worker and the new daemon failed to adopt 7 of them.

The daemon unit is `Type=forking` with `PIDFile=%t/prime-agent-daemon.pid`, because the supervisor that owns the socket is often not the process the unit started.
Prime's update restart coordinator starts the new supervisor itself, and session workers start a replacement when the supervisor goes away.
`prime-agent-daemon-ctl start` adopts the supervisor that answers on the socket, or starts one, and writes its PID to the PIDFile. While an update restart coordinator is alive, it waits for that coordinator's supervisor instead of starting a second one.
On 10-18 at 03:03Z the old `Type=simple` unit ran ExecStart again after the update stopped the old supervisor, that start failed with `ELOCKED` because the new supervisor held the socket lock, and the unit tracked none of them.

Update Prime from a local feed with `deploy/linux/prime-install.sh <feed-dir> <expect-version> [--rollback]`, installed as `~/setup-logs/prime-install.sh`. After a good update it deletes each release under `~/.local/share/prime-agent/releases` that `bin/prime-agent` and `bin/previous` do not name and no running process uses.
The script re-runs itself detached with `setsid` and `nohup`, prints its log path and returns at once, because Prime's update prepare aborts a busy agent bash command after 5 s. On 10-18 that abort killed an attached run mid-wait and skipped its post-checks.
The detached run serves the feed, writes `~/.config/sieun-pi/prime-update.env`, runs `systemctl --user reload --no-block prime-agent-daemon.service`, waits for the reload, checks that the daemon runs the expected build, and writes `<log>.result` with `result=<ctl result> rc=<0|1>`.
ExecReload runs `prime-agent-daemon-ctl update`, and systemd reads the PIDFile when the reload ends, so MainPID moves to the new supervisor with no restart.
A plain `systemctl --user reload prime-agent-daemon.service` runs the same update with whatever the env file holds. From inside an agent session, add `--no-block`, because the update's prepare step waits for the session's own running command to finish.
Do not run `prime-agent update` under `systemd-run`. The new supervisor and the sessions it restores then live in the transient unit's cgroup, and systemd kills them when that unit ends; on 10-18 at 03:03Z that lost the 10 restored sessions.
The env file holds the feed settings `PRIME_AGENT_DOWNLOAD_BASE_URL` and `PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS` and `PRIME_UPDATE_ARGS`, which passes `--force` or `--rollback --force`. The ctl empties it as soon as the reload starts, because systemd has already loaded it, so a later start or reload never picks up the same run.
The ctl updates in two steps, because Prime's restart coordinator copies the updater's environment into the new supervisor and every worker under it. After the 06:46Z update on 10-18 the new supervisor and all 20 workers carried the test feed's URL and insecure-HTTP flag.
1. `prime-agent update --self` with `PRIME_AGENT_INTERACTIVE_SELF_UPDATE=1` and the feed settings installs the release without a restart.
2. `prime-agent update --internal-update-restart-coordinator --daemon-socket <socket> --internal-update-restart-status <file>` runs the coordinator that Prime itself launches after an install, with the feed settings dropped, so the new supervisor gets the unit's environment.

`--force` answers Prime's busy-session confirmation, which refuses without a TTY, and Prime then checkpoints the busy sessions and restores them on the new daemon. It does not override a prepare refusal, where the running daemon declines the restart because a worker is failed, disconnected or not ready.
When the update says prepare refused, as in 'Cannot prepare update restart while resident worker <id> is failed and disconnected (session <path>)', stop the update and list the named workers with `prime-agent list --all --json`.
Reopen a session that is still meant to run and still has its saved file, because an ordinary reopen reclaims a stale descriptor. Leave a session whose recovery state is unknown or whose file is missing alone.
Use `prime-agent stop` only on work someone marked finished or stopped, because in mem.2 it tombstones the session (archiveOnStop), cancels its schedules and archives the transcript before it deletes the descriptor.
Never force the update or restart the daemon around the refusal, with `systemctl --user restart prime-agent-daemon` or `prime-agent shutdown`, because a daemon restart aborts every running turn (c88).
A test of the daemon or the updater runs under `env -i` with an explicit list of variables, and checks that the socket it targets answers as the test daemon before any change. An agent shell inherits `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET=/tmp/prime-agent-1001/daemon.sock`, so on 10-18 an e2e test with only a fake HOME and TMPDIR sent a live update prepare to the real daemon.
The same list points `PI_POOL_DIR` and every other state directory the daemon reads at a temp copy, because a throwaway test daemon that day left test rows in the live pi-pool queue. Its auth comes from a temp copy or a test token, never from logged secrets or changed live accounts.
The ctl prints one `prime-agent-daemon-ctl: result=` line and exits 0 for `ok`, 3 for `busy-refused`, 4 for `prepare-refused`, 5 for `restart-failed` and 1 for any other failure, including an install that installed nothing.
It aims the update at its socket argument through `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` and a matching `TMPDIR`, because the public `prime-agent update` refuses `--daemon-socket` and otherwise follows whatever the environment names.
The unit sets `TimeoutStartSec=infinity`, because systemd times ExecReload with it and a timeout kills the ctl mid-update. On 10-18 an isolated reload whose prepare hit Prime's own worker deadline took 97 s, past the old 90 s default.
`~/.config/sieun-pi/agent.env` (mode 0600) holds keys both units read, such as `LINEAR_API_KEY`. It sets no `PRIME_API_KEY`: no session uses the `prime-inference` provider, and with that key Prime's status summarizer called it after every turn and got 402 for an empty balance, 26,186 times from 07:48Z to 08:36Z on 10-18.
`~/.config/sieun-pi/chat.env` (mode 0600) holds keys only the chat reads, `SIEUN_PI_SLACK_BOT_TOKEN` and `SIEUN_PI_SLACK_APP_TOKEN`, which the Mac keeps in the Keychain. The daemon never loads it, so no agent sees the Slack tokens.
Since 10-18 at 03:20Z the box matches the Mac for auto-sns-agent agents: the same env files (mode 0600), Convex data from a Mac export, the cloud CLIs at the Mac's versions, claude and codex, the Mac's ssh key as `~/.ssh/id_ed25519_mac`, a ghcr.io Docker login, and a `/Users/sieunpark` link to `/home/sieun`.
codex on the box logs in through `codex-pool-auth.timer`, which every 15 minutes writes `~/.codex/auth.json` from `pi-pool token` for the Codex account its service names, now ungsugoe5@gmail.com. The file gets a refresh token codex cannot spend, because pi-pool holds the real one and a second holder's refresh makes the pool's next one fail with refresh_token_reused.
Until 10-22 codex had its own device login as sieunpark77, and the breach response's "log out of all devices" at 10:02Z ended it, so the login now follows the pool instead. Test the script with `python3 -B deploy/linux/codex-pool-auth.test.py`.
ungsugoe5 is a free account, which cannot run the `gpt-6-astra` default in `~/.codex/config.toml`, so pass `-m gpt-5.6-terra` until the unit names a pro account. vercel has its own device login.

## Memory layers

On 2026-10-19 the owner asked for the memory defense layers of https://cho.sh/ko/1983DC on us-metal02, so these layers are owner-asked exceptions to c107.
Root sets them up with `deploy/linux/memory/setup-memory.sh`, which converges on every run, and `python3 -B -m unittest tests/test_memory_layers.py` checks the files.
us-metal01 does not have them yet.

1. A 64 GiB `/swapfile`, written with `dd` and listed in `/etc/fstab`, sits next to the 16 GiB partition for 80 GiB of swap. At 16:4xZ on 10-19 the 16 GiB partition was 100% full while the kernel OOM killer took 18 processes from 16:09Z to 16:40Z, and on 10-18 at 22:13Z it killed one Prime worker holding 52 GiB, so 64 GiB covers a full partition plus one runaway of that size.
2. `zswap-zstd.service` turns zswap on with the zstd compressor at boot, because the kernel ships it off with lzo. zswap keeps its default pool of up to 20% of RAM, and the page picked it over zram because the compressed pages are charged to the process that made them.
3. earlyoom reads `/etc/default/earlyoom` from `earlyoom.default`. It sends SIGTERM to the process with the highest `oom_score` when available RAM and free swap are both under 5%, and SIGKILL under 2%. Its avoid regex keeps systemd, sshd, tailscaled, dockerd, containerd, earlyoom, `prime-agent` and `pi-pool`, and its prefer regex takes the CI VMs (`qemu:ci-g*`) and named test runners first. The regexes match `/proc/<pid>/comm`, where every node process reads `node-MainThread`, so the next layer protects the chat service by score.
4. `heavy <size> -- <cmd>` runs a job known to be heavy under `systemd-run --user --scope -p MemoryMax=<size> -p MemorySwapMax=0` with an `oom_score_adj` of 500. Past the size the kernel kills that job alone, and a box-wide shortage takes it before anything else. An example is `heavy 8G -- pnpm svelte-check`, since svelte-check peaked at 4.2 GB RSS on the box on 10-19. Without systemd, as on the Mac, it runs the command as is. setup-memory.sh installs it as `~/.local/bin/heavy`.
5. ssh and tailscaled run at `OOMScoreAdjust=-500` from unit drop-ins. A user unit cannot lower its own score, so the root service `oom-protect.service` runs `oom-protect.py` every 5 s. It sets -900 on the main process of `prime-agent-daemon.service`, `sieun-pi-chat.service`, `pi-pool-serve.service` and `pi-pool-hookd.service`, and -500 on every Prime worker. Every other process in those units goes back to the user-unit default of 200, because a kernel or agent command forked from a worker inherits the worker's score and must stay killable.
   Those two units run with `OOMPolicy=continue`, so the kernel's pick dies alone. Under systemd's default `OOMPolicy=stop`, one agent command the kernel OOM killer took at 16:13:50Z and again at 16:28:09Z on 10-19 made systemd SIGKILL the daemon supervisor, and every session's turn stopped with it.
6. `/etc/sysctl.d/90-agent-memory.conf` sets `vm.swappiness=100`, `vm.watermark_scale_factor=125` and `vm.min_free_kbytes=1048576` (1 GiB, 0.4% of RAM).
7. `thp-defrag.service` sets `/sys/kernel/mm/transparent_hugepage/defrag` to `defer` at boot, so a huge page fault falls back to small pages and wakes kcompactd instead of compacting memory inside the faulting process. The CI VMs ask for huge pages for guest RAM (about 32 GiB of `AnonHugePages` across 9 qemu guests on 10-23), and under the kernel's `madvise` default each of their faults compacted in place on a fragmented box: 182 compaction stalls a second moved 185,000 pages a second.
   A page in flight is locked, so every other process that touched one waited for it. On 10-23 the chat service's main thread waited 1.65 s in 150 s on such pages (`softleaf_entry_wait_on_locked` from `migration_entry_wait`), up to 256 ms at once, and those waits on top of its own work made the 1.1 to 2.2 s event loop stalls d7 counted. A minute after the switch at 08:15Z, compaction stalls fell to 0, page moves to 39,000 a second (31,000 of them NUMA balancing), and the main thread's waits on locked pages to 0.07 s in 150 s, its longest under 32 ms, at load 200 to 285 (`/home/sieun/work/d7-chat-stalls/findings.md`).

The CI VMs are libvirt guests that `virev-ci-virt@` starts as root, and each one's RSS is bounded by its guest RAM, so they are not wrapped in `heavy` and earlyoom's prefer regex picks them first instead.

`/tmp` on us-metal02 is a 124 GiB tmpfs, so a dir a finished job leaves there holds RAM and swap.
On 10-18 it held 32.6 GB of such dirs, about 1 GB per p8iso rig root plus repo clones and test dirs such as `thread-open-*` and `pi-pool-test-*`, charged to `prime-agent-daemon.service` as shmem. Most of the full 16 GiB swap was those tmpfs pages, and deleting the dirs of finished jobs dropped swap from 16.0 to 5.0 GiB.
When user-1001 memory looks high, read `shmem` in its `memory.stat` and run `du -sxb /tmp/*` first, and ignore the 40+ GiB of page cache the kernel can reclaim.
Before you remove a dir, check that no process has it open as cwd, fd or map, and a rig teardown stops the rig's `-r` and `-fake` units too.

## CPU layers

The page https://cho.sh/ko/1983DC says one greedy process should slow down and never take the box down, and the ways back in must stay protected. On 10-19 the owner answered t84 that CPU priority on us-metal02 follows that page and that metal-management owns it, which lifts c107 for these weights. None of them is a cap, so an idle box still gives any process every core.
At 17:1xZ on 10-19 the box ran 73 of 80 cores busy with CPU pressure "some" at 71%, and the chat service used 0.6 cores while its event loop stalled up to 13.8 s and api/accounts took 15.9 s (/home/sieun/work/d7-clean-min-root-cause/findings.md).
Root sets the layers up with `deploy/linux/cpu/setup-cpu.sh`, which converges on every run and restarts no unit, and `python3 -B -m unittest tests/test_cpu_layers.py` checks the files.

1. `setup-cpu.sh` sets `CPUWeight` from a `cpu-weight.conf` drop-in per unit and `set-property --runtime` now. `ssh.service`, `tailscaled.service`, `pi-pool-serve.service` and `pi-pool-hookd.service` run at 1000, 10 times the default. The chat's weight makes systemd turn the cpu controller on in the user manager's `app.slice`, so since 19:47Z on 10-19 each unit there is its own CPU group.
   From 20:34Z on 10-19 agents and prod ran at 300 on every level from the root down, because a weight only counts against its siblings: `user.slice` against `virev.slice` and `dev.slice`, and `prime-agent-daemon.service` against the other units in `app.slice`. `user@1001.service` runs at 10000, the most systemd takes, since 21:2xZ on 10-19, because its siblings are the ssh login scopes, 69 of them at 100 each from Mac jobs at 21:1xZ. `prime-agent-daemon.service` runs at 10000 since 02:49Z on 10-20 for the same reason inside `app.slice`, where 67 job rigs sat at 100 each: at 300 the supervisor waited 0.88 s in the run queue per second of 0.31 s on CPU, and Prime creates took 31 to 43 s; at 10000 it waited 0.41 s. `virev.slice` runs at 400 and `virev-prod.slice` at 300, so prod holds 300 and the CI VMs in `virev-ci.slice` 100. CI VMs, dev docker and world rigs stay at 100, so CI never blocks agents (c108). Since 06:41Z on 10-20 the chat runs at 10000 beside the daemon and `user.slice` at 1000, so the chat's path wins at every level from the root down. Before that, `virev.slice` at 400 carried 25.5 cores of CI VMs and outweighed `user.slice` at 300 at the root, and the chat at 1000 sat below the daemon. At load 202 to 254 its main thread waited 0.31 s in the run queue per second on CPU, and 0.13 s after the change at load 204 to 221. Prod keeps 300 of `virev.slice`'s 400 against CI. After the first layer alone, from 19:47Z to 20:17Z, the box ran 77 of 80 cores busy and the workers waited 14 s in the run queue per second of CPU they used.
2. The Prime supervisor, its workers and their job commands share `prime-agent-daemon.service`'s cgroup, so inside it the root service `cpu-protect.service` runs `cpu-protect.py` every 2 s. It sets nice -10 on every thread of every `prime-agent` process, which inside one cgroup weighs 9548 against 1024 for nice 0, the same 10 to 1. A command forked from a worker inherits -10, so each pass puts every other thread of the unit below 0 back to 0, and a job that niced itself up keeps its value.
   Two threaded child cgroups (core at weight 1000, jobs at 100) were tried on a test unit first. They keep systemd's `ExecReload` working, but systemd's `cgroup.kill` fails on them with "Operation not supported", and host-stats.ts `leafCgroups` would stop seeing the daemon's memory because a threaded child has no `memory.stat`, so the nice split is the live one.
3. The root service `rcu-boost.service` runs `rcu-boost.py`, which gives a preempted RCU reader the CPU it needs to end its read section. On 10-20 from 11:23Z to 13:06Z a clickhouse thread preempted inside an RCU read section got no CPU, grace period g=220375749 never ended, every rtnl, netns, runc and ss call that waits for one hung, and load reached 907 (`~/work/box-rcu-stall/FINDINGS.md`).
   The Ubuntu 7.0.0-38 kernel runs PREEMPT_RCU without `CONFIG_RCU_BOOST`, so the kernel never boosts such a reader. Its scheduler also still has 6d71a9c61604, which upstream reverted in 101f3498b4bd for v7.1 because it starves a task on a CPU where a busy task pinned there belongs to a cgroup whose weight changes often. On 10-20 that CPU was CPU 3, where 16 or more pinned busy loops from Prime bash() calls in `prime-agent-daemon.service` ran from about 10:49Z.
   The service sets `rcu_cpu_stall_timeout` to 21 s, upstream's default where Ubuntu ships 60, and reads `/dev/kmsg`. When a stall warning names a blocked task (`P<tid>`), it sets that thread to SCHED_FIFO 1 and gives the thread its own policy back after it has run. A thread in exit keeps FIFO until it is gone. The service runs at SCHED_FIFO 1 itself, so the starvation it fixes cannot hold it off the CPU. The Box tools parity duty counts `rcu_boost_off` when it is not running or the stall timeout differs, and `python3 -B -m unittest tests/test_rcu_boost.py` checks it.

## Install

Root runs `loginctl enable-linger sieun` and `tailscale set --operator=sieun` once. Everything below runs as the user.

```sh
# Node 26 and pnpm in ~/.local/node
curl -fsSLO https://nodejs.org/dist/v26.8.1/node-v26.8.1-linux-x64.tar.xz
tar -xJf node-v26.8.1-linux-x64.tar.xz -C ~/.local && ln -sfn ~/.local/node-v26.8.1-linux-x64 ~/.local/node
export PATH=$HOME/.local/node/bin:$HOME/.local/bin:$PATH
npm install -g pnpm@10.32.1

# Prime Agent 0.9.8 with the installer that ships inside its own archive (the public install.sh is 0.10.0 now)
B=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
curl -fsSLO $B/releases/v0.9.8/prime-agent-0.9.8-linux-x64.tar.gz
echo "83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2  prime-agent-0.9.8-linux-x64.tar.gz" | sha256sum -c
tar -xzf prime-agent-0.9.8-linux-x64.tar.gz install.sh
PRIME_AGENT_DOWNLOAD_BASE_URL=$B PRIME_AGENT_INSTALL_METHOD=binary PRIME_AGENT_INSTALLER_NONINTERACTIVE=1 \
  PRIME_AGENT_EXPECTED_SHA256=83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2 sh install.sh 0.9.8
prime-agent --version   # 0.9.8

# Bun for the poteto-mode scripts
curl -fsSL https://bun.sh/install | bash && export PATH=$HOME/.bun/bin:$PATH

# settings.json first, so apply keeps it; the Tools section below adds the aside MCP server
mkdir -p ~/.prime/agent && install -m 0600 /dev/stdin ~/.prime/agent/settings.json <<'EOF'
{"telemetry":{"enabled":false},"defaultProvider":"anthropic","defaultModel":"claude-opus-5-5","defaultThinkingLevel":"high",
 "packages":[],"bundledSkills":{"websearch":false},
 "retry":{"provider":{"waitForUsage":{"pauseUntilReset":false,"maxWaitMs":18300000,"maxAttempts":80}}}}
EOF

# sieun-pi from the checkout, then the pool and the first chat release
cd ~/src/sieun-pi && npm run develop
node scripts/cli.mjs plan --out .work/plan.json && node scripts/cli.mjs apply --plan .work/plan.json && node scripts/cli.mjs verify
/usr/bin/python3 -B components/pi-pool/install.py --ref "$(git rev-parse HEAD)"
node scripts/release-chat.mjs "$(git rev-parse HEAD)" --no-kickstart
/usr/bin/python3 -B components/prime-sync/install.py --ref "$(git rev-parse HEAD)"   # needs gh auth login, and origin set to GitHub

# Units
mkdir -p ~/.config/systemd/user && mkdir -p -m 0700 ~/.prime/agent/browser-chat && install -m 0644 deploy/linux/*.service deploy/linux/*.socket deploy/linux/*.timer ~/.config/systemd/user/ && install -m 0755 deploy/linux/prime-agent-daemon-ctl ~/.local/bin/ && mkdir -p ~/setup-logs && install -m 0755 deploy/linux/prime-install.sh ~/setup-logs/
systemctl --user daemon-reload
systemctl --user enable --now prime-agent-daemon.service sieun-pi-chat.socket sieun-pi-chat.service prime-agent-watchdog.timer
```

The main chat adds itself to Tailscale Serve at `https://<host>.<tailnet>.ts.net/`.

One wiki serves every box. On the host with the `wiki` role, which is us-metal02, the wiki is `llm-wiki.service`; enable it with `systemctl --user enable --now llm-wiki.service`, then run `tailscale serve --bg --https=5176 http://127.0.0.1:5176`, so the wiki answers at the role's url, `https://us-metal02-dev.tail0c093d.ts.net:5176`.
Its pages are committed from that checkout, which holds the `sieun/dev` tip: `wiki-box-commit.timer` runs `scripts/repo/agent/wiki-box-commit.mjs` in the checkout every 5 minutes, so it runs whatever has landed, with no installed copy. It builds one object from the wiki pages that differ from HEAD with `commit.mjs --object-only`, which runs the prose lint and secret scan, leaves out a page the duplicate-page gate refuses, and lands the rest with `land-object.mjs`. It finds new pages by reading the curated spaces and the recent session day folders, not with `git status`, which listed 750,658 untracked files and took 184 s a run on 10-18; a run takes about 20 s. Wiki pages need no probe.
The wiki serves the content folder of that checkout. Restart it with `systemctl --user restart llm-wiki.service`, and read its log with `journalctl --user -u llm-wiki.service`. `pnpm dev`, `pnpm dev:status` and pm2 do not cover it, because on 10-18 a6b71cc0bf took llm-wiki out of the pm2 stack while this page still sent people there, and :5176 was down from about 08:47Z to 08:51Z.
Check with `ss -tlnp` that 5182 and 5176 listen on 127.0.0.1 only.

One CI cache poller runs, on us-metal02, so the sieu-n token's 5,000 calls an hour are spent once. `ci-cache.service` runs `scripts/dev/ci-cache.mjs poll` through `~/.cache/virev/tip-export/current/scripts/dev/run-from-head.mjs --tip --follow-head`, so it runs the box's `sieun/dev` tip and needs no reinstall when a fix lands. When the tip moves and changes a file the poller loads (the script, its relative imports followed recursively, or run-from-head.mjs), run-from-head stops the poller right after its next cycle line and starts it from the new export in the same process, so ci-runs.json misses no cycle. A tip move that changes none of them leaves the poller running, because the tip moved 925 times in the 6 h to 17:20Z on 10-18 while 11 commits touched the poller's 8 files. `ci-monitor.service` and `ci-history.service` run from the same tip export with `--tip`, on their 10-minute timers. The unit sets `CI_CACHE_REAL_GH` to the box gh and `CI_CACHE_QUOTA_PROM` to node_exporter's textfile, since the code defaults to the Mac's paths. `ci-head-fetch.timer` runs `git fetch origin +refs/heads/sieun/dev:refs/remotes/origin/sieun/dev` in `~/Documents/Github/auto-sns-agent` every 5 minutes, so pins and lands on the box see the pushed head. It writes that one ref and no FETCH_HEAD, and never moves `sieun/dev`, the working tree or `.git/index`. One fetch takes about 0.45 s and spends no REST quota. A poller restart costs about 172 extra calls while its ETags warm up. Install `deploy/linux/gh-ci-cache` as `~/.local/bin/gh` and `deploy/linux/ci-run-status` as `~/.local/bin/ci-run-status`. Both run the same tip export. The release toggle and the infra rerun watcher run inside the poller, so `release-runner.enabled` and `infra-rerun.enabled` sit in the box's `~/.cache/virev`.
The Mac keeps a read copy for its own readers. `deploy/mac/ci-cache-mirror.mjs`, installed in `~/.local/share/ci-cache-mirror` and run by `deploy/mac/ai.virev.ci-cache-mirror.plist`, pulls the cache every 15 s with one `rsync -az` over a shared ssh connection into `~/.cache/virev/.mirror`, then clones the changed files into place, and hands the Mac's `ci-wants` to the box over the same connection. The poller rewrites the 32 MB `ci-runs.json` every cycle. Copied whole through the relay, it kept one flow from the box to the Mac busy at about 360 KB/s and often timed out after 60 s, while the rsync delta of one cycle is about 140 KB. Test it with `node --test tests/ci-cache-mirror.test.mjs`.

The watchdog lives in `components/watchdog`. Install it with `python3 -B components/watchdog/install.py --ref <sha>`, which writes its two units too. The timer gives it the Linux daemon socket through `PRIME_AGENT_DAEMON_SOCK`.

## Update

Release a commit to the chat with `node scripts/release-chat.mjs <sha>`. On Linux it restarts `sieun-pi-chat.service` instead of kickstarting the LaunchAgent.
`sieun-pi-chat.socket` holds port 5182 across a restart, so the kernel queues the page's requests while the service stops and starts instead of refusing them. When the release's `sieun-pi-chat.service` or `sieun-pi-chat.socket` differs from the installed one, release-chat copies both into `~/.config/systemd/user`, runs `daemon-reload`, stops the service, enables and starts the socket, then starts the service.
Update the pool with `/usr/bin/python3 -B components/pi-pool/install.py --ref <sha>`.

## Tools

The Settings > Tools and skills panel checks each box in `~/.config/sieun-pi/hosts.json` for the tools its `tools` list names, on that box: `websearch`, `headless-browser` (aside-browser's box runner), `aside` and `cua-driver`. A tool a box does not list shows as not used on that host, never as a failure. us-metal02 lists `websearch`, `headless-browser` and `aside`, and the Mac lists `websearch`, `aside` and `cua-driver`. The box has no cua-driver: its virtual display showed a blank screen with no apps, and from 10-12 to 10-19 box sessions made 38 cua-driver calls in 5 chats, none of which needed it. On Linux each tool needs these steps.

1. Web search reads a Virev key from `"virev": {"type": "api_key", "key": "kb_live_..."}` in `~/.prime/agent/auth.json`. Run `uv sync` in `~/.prime/agent/skills/websearch`, and install `websearch`, `board` and `aside-browser` into the kernel venv from `~/.prime/agent/skills/<name>` with `uv pip install --python ~/.prime/agent/kernel-venv/bin/python -e`. Install `playwright==1.64.0`, `greenlet==3.5.6` and `pyee==13.0.1` there too with `uv pip install --python ~/.prime/agent/kernel-venv/bin/python`, because the Mac's kernel venv has them since 10-22 and box parity counts every package the Mac's has.
2. Aside Browser has no Linux build, and `aside host use` answers 403 for this account, so the box runs a Mac's Aside CLI over ssh. Install `deploy/linux/aside-remote` as `~/.local/bin/aside`. It runs the CLI on the Mac that `ASIDE_REMOTE` or the first word of `~/.config/aside-remote/host` names: `mac` is the owner's MacBook and the default, and `air` is the always-on M2 Air (`a.@dbhost`), which runs Aside under the launchd agent `local.aside-browser`.
3. Xvfb comes from Ubuntu debs unpacked without root. Run `apt-get download xvfb xserver-common libxfont2 libfontenc1 x11-xkb-utils` and unpack each one with `dpkg-deb -x <deb> ~/.local/opt/xvfb`.
4. Xvfb runs `/usr/bin/xkbcomp`, which the box lacks. Copy `usr/bin/Xvfb` to `Xvfb-localxkb` and replace its one `/usr/bin\0` string with `.\0` padded by NULs to 9 bytes, so it runs the unpacked `xkbcomp` from its working directory.
5. Add the `aside` server to `settings.json` as in the main README, with `/home/sieun/.local/bin/aside` as the command.
6. The box browser runs `~/.prime/agent/skills/aside-browser/box/box.mjs`; install it with `npm ci` in that folder, which needs Playwright's Chromium in `~/.cache/ms-playwright`.

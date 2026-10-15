# sieun-pi on a Linux box

These units run Prime Agent 0.9.8, the browser chat and the wiki as one Linux user under systemd, the way launchd runs them on the Mac.
They were written for user `sieun` on us-metal02, whose user slice is fenced to one CPU socket.
The chat listens on 127.0.0.1:5182 and the wiki on 127.0.0.1:5176; Tailscale Serve is the only way in.

| Unit | What it runs |
| --- | --- |
| `prime-agent-daemon.service` | The Prime Agent daemon on `/tmp/prime-agent-<uid>/daemon.sock`, with the agent workers under it. |
| `sieun-pi-chat.service` | The chat from `~/.local/share/sieun-pi-chat/current`, the release folder that `scripts/release-chat.mjs` builds. |
| `prime-agent-watchdog.timer` | One cycle of `~/.prime/agent/watchdog/cron_cycle.py` every 10 minutes, as `com.sieun.prime-agent-watchdog` does on the Mac. |
| `llm-wiki.service` | `pnpm run dev` of `apps/llm-wiki` in `~/src/auto-sns-agent`. |

The daemon has its own unit, so a chat restart never stops a running agent. The chat unit sets `SIEUN_PI_CHAT_START_DAEMON=0` and `KillMode=process` for the same reason.
`~/.config/sieun-pi/agent.env` (mode 0600) holds keys both units read, such as `PRIME_API_KEY` for the `prime-inference` provider.

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

# Bun for the poteto-mode scripts and tokenmaxxing
curl -fsSL https://bun.sh/install | bash && export PATH=$HOME/.bun/bin:$PATH

# settings.json first, so apply keeps it: no aside, cua-driver or paper MCP servers, which are macOS apps
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

# Units
mkdir -p ~/.config/systemd/user && install -m 0644 deploy/linux/*.service deploy/linux/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now prime-agent-daemon.service sieun-pi-chat.service llm-wiki.service prime-agent-watchdog.timer
```

The main chat adds itself to Tailscale Serve at `https://<host>.<tailnet>.ts.net/`. The wiki goes on another port with `tailscale serve --bg --https=8443 http://127.0.0.1:5176`.
Check with `ss -tlnp` that 5182 and 5176 listen on 127.0.0.1 only.

The watchdog code is not in this repository. Copy `watchdog.py`, `cron_cycle.py`, `repl_guard.py` and `repl-guard.patch` from the Mac's `~/.prime/agent/watchdog`, without its state and logs. The timer gives it the Linux daemon socket through `PRIME_AGENT_DAEMON_SOCK`.

## Update

Release a commit to the chat with `node scripts/release-chat.mjs <sha>`. On Linux it restarts `sieun-pi-chat.service` instead of kickstarting the LaunchAgent.
Update the pool with `/usr/bin/python3 -B components/pi-pool/install.py --ref <sha>`.

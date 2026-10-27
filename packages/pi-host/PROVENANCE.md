# Provenance of the code pi-host takes from Prime Agent

Prime Agent is MIT licensed, and both sources below carry that license.

## The rlm-heartbeat skill

`skills/rlm-heartbeat` is Prime's bundled skill, copied unchanged on 2026-10-27 without `__pycache__` from the installed release folder `~/.local/share/prime-agent/releases/0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-test-linux-x64-beb9504fee1c53ac7685acb6abf382ac046c017e70234e29839625acb446dcaa/` on us-metal02.
The release `LICENSE` is the same file as `pi-rlm/python/LICENSE` (SHA-256 `b288615fb31dc504623582fb790a28e6d86bc2f5c1396845af555e43386da5a0`).

| Source file | SHA-256 |
|---|---|
| `skills/rlm-heartbeat/SKILL.md` | `021daa60f9e9a89d682eee8257703d8b34355d1e0d05124860e37db3e3117565` |
| `skills/rlm-heartbeat/pyproject.toml` | `e9e04a90898739767f8b9cb83a72bd18fdad318c9b179f76fdbb6b7b1f64abbd` |
| `skills/rlm-heartbeat/src/rlm_heartbeat/__init__.py` | `81b3121c4f6dd227a5e093b1b5372d72f01eb1b174c4aafcff04c9f2118155db` |

## The schedule grammar

`src/schedule.ts` ports the schedule parser, the `/heartbeat` argument parser, the heartbeat deferral rule, the `heartbeat_prompt` message and the `rlm_heartbeat` response shape from the `prime-agent` 0.9.8 npm package, `"license": "MIT"`, installed at `components/user-history/node_modules/prime-agent`.
`src/scheduler.ts` follows the claim, result and recovery order of the same file's `AgentCronJobStore` and `AgentCronScheduler`, and is new code.

| Source file in `prime-agent/dist` | SHA-256 |
|---|---|
| `core/cron-jobs.js` | `e7996b187f7758116385409976ed7f4c86379c7079c0e1ada63f544c58f8fd0e` |
| `core/messages.js` | `2fe4dde1db9ed66521fdfd71fa58713678c2697edc5cde7eb20b366e15c7d79a` |

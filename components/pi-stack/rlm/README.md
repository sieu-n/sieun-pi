# pi-rlm

pi-rlm is Prime Agent's RLM kernel as an upstream Pi extension, build step 2 of `components/pi-stack`.
Load it with `pi -e components/pi-stack/rlm/index.ts --tools ipython`, or as an extension factory in pi-host.

## What it does

1. It registers the `ipython` tool, which runs each cell in one persistent `python -m rlm.repl` process per session and streams output through `onUpdate`.
2. It answers the kernel's `host_request` calls, and it looks each method up in `shared/kernel-bridge.ts` first, so pi-agent-bus and pi-harness answer their own methods.
3. A `bash()` handle that outlives its cell sends `[bash-done pid:<pid> exit:<code>]`, which starts a run when the agent is idle and goes in at the next turn end when it is busy, unless a live cell read the handle first.
4. `rlm.spawn` opens a child `AgentSession` in the same process with `createAgentSession`, after `assignIdentity` names it in `shared/registry.ts`, and returns the handle before the child runs.
5. A child that ends without replying sends the parent `[child-exited: no-reply child:<name>]` with its last text, and a failed child sends `[child-failed child:<name>]`.
6. `rlm.list_subagents`, `rlm.collect`, `rlm.delete_subagent`, `rlm.progress_note` and `rlm.find_models` work on the parent's child index in `<artifact dir>/rlm-children.json`, and a reopened parent registers its closed children as dormant rows.
7. Child usage goes on the parent transcript as `child_usage_attributed` custom entries until upstream Pi has `pi.appendUsage`.
8. The namespace survives compaction because the kernel process stays up, and it survives a restart through `kernel-state.dill`, which pi-rlm writes after every run and at shutdown.
9. `goal.*` keeps the goal as `rlm_goal` custom entries in Prime's shape, and while a goal is active each settling run gets a `[goal: continuation]` message, unless the run errored or was aborted, a compaction is pending, or a child or a `bash()` handle is still working.
10. A goal that spends its token budget turns `budget_limited` and gets a `[goal: budget-limit]` steer, and `/goal [--budget <tokens>] <objective>`, `status`, `pause`, `resume` and `clear` manage it.
11. `compact.run` compacts after the run settles and resumes it with a `[compaction-resume]` message.
12. `rlm.create_session` opens a root in pi-host, in-process through `hostApi()` or over `PI_HOST_SOCKET`.

## Python

The kernel runs the vendored Prime runtime in `python/`, listed with its hashes and changes in `PROVENANCE.md`.
Set `PI_RLM_PYTHON` to a Python 3.11+ that has `dill`, `tyro` and `mcp`, or let pi-rlm build a uv venv at `<agent dir>/rlm/kernel-venv`.
Every loaded Pi skill with a `pyproject.toml` and `src/<import name>/` is installed in that venv and imported by name when the kernel starts.

## Children

`RLM_MAX_DEPTH` (default 2) caps the depth, and `/rlm-max-depth <n>` changes it for one session.
A child loads the parent's `-e` extension paths from argv, or what `setChildLoaderOptions(fn)` returns, which pi-host and the tests set.

## Real-provider check

`rig/rpc-check.mjs` runs P1, P2 with 10 children, a compaction and a restart in `pi --mode rpc`, and `rig/inprocess-check.ts` runs the same in an in-process runtime.
Both take `RIG_DIR` (with `agent/models.json`), `EVIDENCE_DIR`, `MODEL`, `CHILDREN` and `EXTRA_EXTENSIONS`, and `rig/async-token.ts` vends pi-pool's token without Pi's `execSync`.
The 2026-10-27 results are in `/home/sieun/work/pi-migration-build/step-2/report.md`.

## Tests

```sh
cd components/pi-stack
node --import tsx --test --test-force-exit rlm/test/*.test.ts
```

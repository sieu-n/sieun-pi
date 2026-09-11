# Skill source checks

This tree contains 51 `SKILL.md` definitions and the auxiliary `skills` Python package.
The source checker reports current counts. Dependency directories and build output do not count as source.

## Read-only checker

`uv run python scripts/check_skills.py` uses the root environment.
It requires Python 3.11 or later and PyYAML, both declared in the root `pyproject.toml`.

| Source | Check |
| --- | --- |
| `SKILL.md` | Safe YAML parsing, unique keys, name and directory agreement, description, invocation flag, metadata type, and body. |
| `*.py` | In-memory Python compilation. No imports, script execution, or bytecode writes. |
| `*.json` | JSON parsing. |
| `*.toml`, `uv.lock` | TOML parsing. |
| `*.yaml`, `*.yml` | Safe YAML parsing with unique keys. |
| Skill roots | A skill definition or a Python package initializer must exist. Source symlinks fail the check. |

The checker reads the checkout by default. `--skills-dir PATH` selects another source tree.
It returns exit code 1 for invalid source or an empty skill tree.
It does not check Markdown prose, browser behavior, service access, or Prime Agent compatibility.
Bun validates its lockfile and TypeScript source separately.

`uv run python -m unittest discover -s tests -p test_skills.py -v` tests the checker and profile path controls.
All test writes use temporary directories. The tests do not run session recovery, publish tickets, or call live services.

## Python packages

Each of `websearch`, `linear-ticket`, and `aside-browser` has its own `pyproject.toml` and `uv.lock`.
For example, these commands build and import the packaged websearch module without a Prime Agent runtime.

```sh
uv sync --project skills/websearch --no-editable
uv build --project skills/websearch --out-dir skills/websearch/dist
uv run --project skills/websearch --no-sync python -I -c 'import websearch; print(websearch.__file__)'
```

The other module names are `linear_ticket` and `aside_browser`.
The `-I` import checks the installed package, without the checkout or `PYTHONPATH` on the import path.
The root environment installs all three packages as editable dependencies.

`uv run python -m unittest discover -s skills/linear-ticket/tests -v` runs the local ticket checks and HTML rendering tests.
No test uploads assets or changes a Linear issue.

## Bun and shell source

These commands run in `skills/poteto-mode/scripts`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test orch watch-pr
node --check check-plan.mjs
node --check watch-pr/watch-pr
bash -n worktree-audit.sh
```

`bun run typecheck` covers `bootstrap.ts`, `orch`, and `watch-pr`, including compile-time assertions.
The tests use temporary stores and Git repositories. Their GitHub and Graphite inputs are local fixtures.
`bash -n skills/show-me-your-work/scripts/log.sh` checks the remaining shell script from the repository root.

`node_modules`, `.venv`, `dist`, and Python bytecode are gitignored.
The Bun lockfile stays in source. Bun and uv caches can stay inside `.work` through `BUN_INSTALL_CACHE_DIR` and `UV_CACHE_DIR`.

## Profile path controls

`setup-pstack/scripts/toggle-model-invocation.py` accepts `--skills-dir` and `--defaults-file`.
Without `--defaults-file`, its snapshot is `state/setup-pstack/model-invocation-defaults.json` under the active Prime Agent profile.
The snapshot stays outside the skill source tree, including when profile skills are source symlinks.
`--skills-dir` selects skill source. It does not select the profile for runtime state.
`--show` is read-only. `--expose` and `--hide` change the selected skill files.
Tests set `PRIME_AGENT_CODING_AGENT_DIR` to a temporary profile before loading either script.

`setup-pstack/scripts/validate-frontmatter.py --skills-dir skills` checks this checkout without reading the installed profile.
Both scripts use `PRIME_AGENT_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then `~/.prime/agent` when no directory is specified.

## External runtime requirements

| Component | Requirement for operational calls |
| --- | --- |
| `websearch` | Virev credentials and network access. Its console entrypoint also needs Prime Agent's `rlm.skill`. |
| `linear-ticket` | Prime Agent's `linear` skill for publishing. Diagram capture needs `aside_browser`, the Aside browser, and its MCP connection. The console entrypoint needs `rlm.skill`. |
| `aside-browser` | Prime Agent's `rlm.mcp` and an Aside MCP server. Its existing CLI fallback needs the Aside executable, selected through `ASIDE_CLI` or `PATH`. |
| Session recovery and fleet health | A compatible Prime Agent CLI and daemon. Fleet repair can abort, resume, and message sessions. No operational method runs during source checks. |
| `watch-pr` and `orch frontier` | GitHub CLI or Graphite CLI, credentials, and the target repository. Local tests do not prove those live integrations. |

The auxiliary `skills/prime_agent/fleet_health.py` is importable through `PYTHONPATH=skills` from this checkout.
Its full import is `from skills.prime_agent.fleet_health import fleet_health`.
In an installed profile, that path becomes `PYTHONPATH=<profile>/skills`.
It has no skill definition and no automatic pre-import. Prime Agent's Python-skill loader requires both `SKILL.md` and `src/<module>/__init__.py`.
The helper remains source-only rather than adding a 52nd skill definition.

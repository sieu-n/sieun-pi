# Virev verification record

## Global policy and cache-stable writing instructions

The September 11 consolidation registers one global Prime Agent entry.
Only explicitly configured project roots receive the named `auto-sns-agent` policy.
Policy modules are separate from the extension dispatcher and global writing rules.

The cache fix moves the full writing document into stable system instructions.
It removes the request-time `context` handler and unused lint-reminder state.
The guard, hot loading and report-only lint remain.

```text
before_agent_start -> host prompt + short rules + full unslop document
user/tool history -> unchanged -> provider conversation prefix
message_end -> prose lint -> diagnostic log and status line
```

The former production hostname appeared only in a denial message, not a runtime comparison.
Removing it did not change a guard decision. Ordinary and `CONVEX_DEPLOYMENT=prod:example` forms
of `convex dev --once` remain blocked in an opted-in checkout.
No additional private production value is needed in configuration.

## Checks

```sh
node --test tests/virev-*.mjs
npm run check
npm run build
npm run prove:runtime -- --home <isolated-home> --project <isolated-project>
```

| Check | Evidence |
| --- | --- |
| `tests/virev-guard.test.mjs` | Native shell/Python dispatch, destructive blocks, read-only controls and scoped command targets |
| `tests/virev-standing-rules.test.mjs` | Both system documents, separate duplicate markers, overrides, stable instructions, absent history mutator and report-only lint |
| `tests/virev-shell.test.mjs` | Global source link, no context handler, hot swap, last-good recovery and fresh-factory reload |
| `tests/virev-scope.test.mjs` | HOME/override configuration, malformed input, multiple roots, nested Git boundaries, symlink escapes and scoped Convex checks |
| `tests/virev-native.test.mjs` | Prime 0.9.4 global discovery, policy-file watcher, last-good recovery, resource reload and unrelated-project behavior |
| `scripts/prove_runtime.mjs` | All global resources, command uniqueness, two reloads, guard scope and stable historical Anthropic payloads |

The global-policy implementation passed 145 tests before cache integration.
Combined post-merge results belong in the root verification record once rerun.
The shell test uses a local API fixture. The native tests use Prime Agent's actual loader.
No destructive command is executed.

The provider payload proof stops in the native adapter callback before network access.
It compares historical content after removing moving `cache_control` markers.
It does not measure server cache hits. A separate owner-authorized provider comparison supplied that evidence.

## Source activation

Verify the combined source and an isolated profile before activating registrations.
Removing an event registration needs a native resource reload, not only implementation hot swap.
Use `/reload` or `/virev-reload` when an affected session is idle. Do not restart working workers.
New sessions load the current source. Credentials, provider routing and account stores do not need changes.

The supported host is Prime Agent 0.9.4. Upstream Pi compatibility is not established.
Earlier migration evidence is retained privately and summarized in `docs/verification.md`.

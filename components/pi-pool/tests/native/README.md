# Native recovery regressions

Run these against a copied Prime Agent install, never the installed package.
Set `PI_POOL_PRIME_AGENT_ROOT` to that copy and `PI_POOL_TEST_OUTPUT_DIR` to an existing temporary output directory.
Use an isolated HOME and `PRIME_AGENT_CODING_AGENT_DIR` for the boundary tests.
The RPC fixtures create isolated worker homes, sessions, and loopback providers. Every credential is synthetic.
A fresh HOME does not isolate macOS Keychain. Python audit hooks and the native Node preload
reject `security` subprocesses and remote network access before those calls run.
The fixtures inherit these guards into Python hooks and Prime child processes.
Guard violations write an external marker and fail the suite even if application code catches the error.
The Python suite includes five probes that verify Keychain, URL, socket and fetch denial.
Do not remove the guard environment from child processes.

```text
/usr/bin/python3 -B -m unittest discover -s tests
node tests/native/recovery.mjs
node tests/native/abort-hook.mjs --warm
node tests/native/registry.mjs "$PI_POOL_PRIME_AGENT_ROOT"
node tests/native/retry.mjs "$PI_POOL_PRIME_AGENT_ROOT"
```

`recovery.mjs` runs 38 cases across Codex and Claude. Add case names to select a subset.
`FIXTURE_EXPECT=baseline` checks old behavior where that expectation exists. The default checks recovery.
`PI_POOL_TEST_RETRY_ENABLED=false` disables retries. `PI_POOL_TEST_MAX_RETRIES` sets the retry limit.
Use those options with `prompt-hook-exhaust` and `prompt-hook-exhaust-claude` to test exact counts.
The fixture writes saved sessions, requests, assertions, and its latest run path under `PI_POOL_TEST_OUTPUT_DIR`.
It checks one tool effect, stable session identity, fresh key/header pairs, and stable retry IDs and bodies.
`threshold-split-auth-recover` holds both initial native summary slices before rejecting their old credentials.
It checks two distinct slice IDs, two attempts per slice, and one compaction commit with the tool call/result retained in live and wire context.

`abort-hook.mjs --warm` checks no provider submission after abort while an in-flight credential owner completes.
`registry.mjs` checks lazy fallback, source fingerprints, a native API-key candidate marked stale, and failed-hook abort before fallback.
It does not test real OAuth rotation. `retry.mjs` checks the native completion retry function with synthetic request/provider/lifecycle messages.
Those boundary tests complement RPC tests. They do not replace end-to-end provider requests.

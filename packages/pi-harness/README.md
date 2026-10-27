# pi-harness

pi-harness is Prime Agent's continual harness as an upstream Pi extension, build step 4 of `packages`.
It loads as the factory `createHarnessExtension()` in pi-host, or on its own into stock Pi.

## Install alone into stock Pi

pi-harness needs only the session and its store, so it works with no other sieun-pi package loaded.
It imports `@sieun-pi/pi-family`, which resolves from the `packages/` workspace, so run `npm ci` in `packages/` once first.

```sh
cd packages && npm ci
pi install ./packages/pi-harness      # adds it to Pi's settings, loads src/pi/index.ts in place
pi -e ./packages/pi-harness           # one run only, no settings change
```

Without pi-rlm the digest and `/refine` work the same, and the kernel's `refine.*` calls simply have no kernel to come from.

## Layout

| Path | What it holds |
|---|---|
| `src/pi/index.ts` | The stock Pi extension: the digest hooks, `/refine`, auto-refine and the kernel's `refine.*` handlers. |
| `src/core/` | The store, digest, refine planner and review, conversation fitting and file lock, with no extension API in them. |
| `skills/refine/` | Prime's kernel skill, returned from `resources_discover`. |
| `test/` | The package tests, with pi-rlm and pi-testkit as dev dependencies. |

## What it does

1. It keeps the global store at harness.py's path: `RLM_GLOBAL_HARNESS_STATE_DIR`, else `<agent dir>/harness/harness_state.json`, where the agent dir is `PRIME_AGENT_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then `~/.prime/agent`.
2. It keeps a session's local store at `<artifact dir>/harness/harness_state.json`, with the artifact dir from `pi-family/paths.ts`, the same file the kernel's `rlm.harness` writes through `RLM_HARNESS_STATE_DIR`.
3. Every write takes `<file>.lock`, reads the file again under it and replaces the file atomically, so pi-harness, the vendored `harness.py` and prime-sync's merge never overwrite each other.
4. At each run start `before_agent_start` adds a hidden `harness_digest` message with Prime's full digest, or a `[harness-digest update]` delta when the stores changed since the digest in context.
5. A compaction drops old digest messages, so the first run after it gets the full digest again, and `session_before_compact` keeps digest and `refinement_outcome` messages out of the summarizer.
6. `/refine [--global] [instructions]` and `/refine rollback <id> [--global]` plan with Prime's planner prompt on the session model, or on the `auxiliaryModel` setting with no fallback, apply the edits and post `refinement_outcome` and `refinement_notice` messages.
7. The kernel's `await refine.run(...)` and `await refine.status()` reach pi-harness through `pi-family/kernel-bridge.ts`, and the self refine runs after the run settles and resumes the agent with the notice.
8. A root session runs auto-refine after 25 assistant turns or a compaction, with a 20-minute cooldown, as Prime's review gate and then the planner, read from the `autoRefine` settings keys Prime uses.
9. A global refine appends its record to `<global dir>/refinements.jsonl`, and every refine saves a `prime-agent.refinement` custom entry, which `/refine rollback` reads.
10. `skills/refine` is Prime's kernel skill, returned from `resources_discover` so pi-rlm imports it.

## Digest route

The digest goes in as a custom message by default, because 30-turn runs on claude-opus-5-5 through pi-pool, with one entry changed at turns 10 and 20, wrote 14,684 cache tokens that way against 40,915 as a system prompt section.
With Pi's built-in claude-opus-5-5 entry, which takes mid-conversation system messages, the section route still wrote 23,224 against 14,768, because each change appends the whole digest while the message route appends only the changed lines.
`harness.digestRoute: "section"` in settings, or `PI_HARNESS_DIGEST_ROUTE=section`, puts it in the `harness_state` system prompt section instead.
The measurements are in `~/work/pi-migration-build/step-4/`.

## Tests

```sh
cd packages/pi-harness
npm test
```

`test/parity.test.ts` compares the digest, delta, fingerprint, planner text, edit checks, apply and rollback with the output of Prime's own bundled functions, and `PROVENANCE.md` lists what came from the Prime release.

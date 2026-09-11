# Virev for Prime Agent

This component runs the shared-checkout guard, stable writing instructions, and report-only prose linting.
Its runtime host is Prime Agent 0.9.4. Upstream Pi compatibility is not verified.

## Global installation and project scope

The installer registers `components/virev/extensions/virev.ts` once in the global Prime Agent profile.
It does not install a second project entry or implementation link. All sessions load the maintained component tree.
The entry resolves its real file path before loading code. It imports no runtime code from `auto-sns-agent`.

```text
global Prime Agent profile
  -> sieun-pi/components/virev/extensions/virev.ts
       -> temporary copy of ext-impl/virev + repo-hooks + policies
       -> canonical source standing-rules.md + skills/unslop/SKILL.md
```

Only `virev.ts` belongs in extension discovery. The implementation, scope helper, and policy files are ordinary Node modules.
The full source layout must stay intact. Public installation keeps `skills/unslop/SKILL.md` beside `components/`.

Company Git, Convex, and local-check policy requires an explicit global opt-in.
The configuration file is `~/.prime/agent/virev-projects.json`:

```json
{"projects":[{"root":"/absolute/project","policy":"auto-sns-agent"}]}
```

`VIREV_PROJECTS_FILE` overrides that file. It does not merge with the default file.
The component reads configuration on each eligible tool call, so removing a project takes effect without a reload.
A missing or malformed file disables project policy. Invalid entries are ignored. Unknown policy names apply no guard.
Roots must be existing absolute directories. Multiple roots may opt in independently.
Neither a directory name nor the obsolete project-local marker opts in.

The guard starts from runtime `ctx.cwd`, or `process.cwd()` when no context cwd exists.
It resolves real paths and chooses the closest configured root without crossing an independent Git boundary.
Nested Git directories and worktree `.git` files do not inherit the outer policy.
A nested repository can opt in through its own configuration entry. Symlinks outside a configured root stay outside.

The policy receives `{ repoRoot, cwd, policy }`. It never derives the protected checkout from its own source location.
Literal `cd`, `git -C`, and Git directory options select the command target inside that scope.
A session outside configured roots receives no company policy. Writing rules and report-only lint stay global.

```text
tool_call
  -> bash or ipython?
       no  -> unchanged
       yes -> configured cwd and known policy?
                no  -> unchanged
                yes -> extract literal shell commands
                       -> policies/auto-sns-agent
                       -> check target remains inside configured checkout
                       -> block reason, warning, or unchanged
```

Project-specific Git rules, Convex checks, workflow paths, and branch names live in `policies/auto-sns-agent/`.
The extension dispatcher and configuration reader contain no company workflow instructions.

The guard blocks shared-tree changes such as reset, stash writes, forced pushes, whole-tree staging, and checkout discards.
It warns and allows new-branch creation without discard flags through `git checkout -b` and `git switch -c`.
The bundled project checks also reject manual `convex dev --once`, duplicate Convex watchers, and the local checks listed in `policies/auto-sns-agent/agent-guards.mjs`.
Read commands and named-file staging stay allowed.

Python extraction covers Prime Agent's `bash("...")`, `await bash("...")`, literal subprocess calls, `%%bash`, and `!` escapes.
Python comments and quoted call examples are not invocations.

## Writing rules and lint

`before_agent_start` appends `standing-rules.md` and the full bundled `skills/unslop/SKILL.md` document to the host system prompt.
Each block has its own marker, so existing short rules do not suppress the full document and repeated starts do not duplicate either block.
The rest of the host prompt stays intact. The document is loaded once per implementation generation.

There is no `context` handler. User messages, images, assistant turns, and tool results pass through unchanged.
This keeps historical request content stable, so Anthropic can reuse the cached conversation prefix.
The former request-only reminder disappeared from historical messages on later calls and invalidated those prefixes.

The document path resolves from the canonical implementation directory through `../../../../skills/unslop/SKILL.md`.
`VIREV_UNSLOP_DOC` can override it. A missing document is logged; available short system rules still apply.

`message_end` runs the existing linter rules. It reports counts to the log and status line.
It never rewrites, replaces, or blocks a finished assistant message, and it does not feed lint findings into model requests.

## Reload

Edits to implementation, scope helper, or policy `.mjs` files trigger a debounced load of a unique temporary module tree.
A failed edit leaves the previous implementation active. The diagnostic log records implementation loads and failures.
The implementation loads from a new path because Prime Agent's jiti loader can retain nested imports at an existing path.

`/virev-status` remains removed. `/reload` is the native full reload. `/virev-reload` calls the same supported command-context method.
Use a full reload after changes to registered events, commands, the TypeScript entry, or the bundled full rules document.
No command context survives a reload. The removed `VIREV_EXT_AUTORELOAD` flag has no effect.

## Configuration

| Variable | Effect |
| --- | --- |
| `VIREV_PROJECTS_FILE=<path>` | Read project opt-ins from this file instead of `~/.prime/agent/virev-projects.json` |
| `VIREV_EXT=off` | Disable guard, rule injection, and lint |
| `VIREV_GIT_GUARD=off` | Disable the guard |
| `VIREV_STANDING_RULES=off` | Disable system writing instructions |
| `VIREV_LINT=off` | Disable prose lint |
| `VIREV_UNSLOP_DOC=<path>` | Read the full writing rules from this path |
| `VIREV_EXT_LOG=<path>` | Write diagnostics here instead of the OS temp directory's `virev-ext.log` |
| `VIREV_FAULT_INJECT=<feature>:inner` | Test a feature's error handling |
| `VIREV_FAULT_INJECT=<feature>:outer` | Test the shell's error handling |

Feature names for fault tests are `git-guard`, `standing-rules`, and `lint`.

## Limits and verification

This guard checks literal command text. It is not a sandbox.
It cannot inspect commands assembled from Python variables, helper scripts, or a subprocess's later input.
Python extraction skips cells above 200,000 characters. Shell parsing is conservative and does not execute shell expansion.
The Python kernel's later cwd changes are not visible until the runtime context reflects them.

Handler errors fail open and write a diagnostic. A failed initial implementation load reports an error in the UI when one exists.
The native runtime proof checks global discovery, policy hot swap, last-good recovery, and the registered guard and writing-rule handlers.
It executes no command under test and sends no model requests.

The Node tests submit destructive strings to the guard without executing them.
See [the verification record](REPORT.md) for commands and results.

## Provenance

The initial implementation came from `auto-sns-agent/.prime/agent/extensions/virev.ts` and `.prime/agent/ext-impl/virev`.
The bundled helpers came from `auto-sns-agent/.claude/hooks/agent-git-guard.mjs` and `agent-guards.mjs`.
This source copy adds global project configuration, separate policy modules, and Prime Agent tool dispatch.
These origins remain attributed after the original project implementation is removed.
The `lint-core.mjs` rules remain unchanged. The report-only wrapper no longer stores reminder state.

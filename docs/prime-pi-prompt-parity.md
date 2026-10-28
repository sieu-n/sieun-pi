# Prime and pi prompt parity

A pi thread now gets the system prompt of a Prime browser chat, built by Prime's own code from the same files.
Before this change a pi thread's whole system prompt was Prime's three-line preamble (268 bytes) and its tool list.
A Prime chat's system prompt is about 51 KB, and Prime sends about 75 KB more as messages: the repo's `.claude/rules`, the harness digest and the corrections block.

On 2026-10-28 the builder reproduced the system prompt of 7 of the 11 Prime chat roots on us-metal02 byte for byte, including one on `openai-codex/gpt-6-astra` and five whose pinned brief is older than today's.
The other 4 captures are from chats that last loaded the global AGENTS.md before its rule 5 was rewritten (captured from 10-27 13:12 to 10-28 15:45 UTC), and each first differs at that rule, because Prime keeps the AGENTS.md a session loaded until it reloads.

## How each prompt is captured

```sh
node scripts/prompt-parity.mjs --out /tmp/parity                    # newest Prime chat capture, newest pi thread
node scripts/prompt-parity.mjs --out /tmp/parity --session <id> --thread <id> --tools pi
```

The script only reads. It writes `prime/`, `builder/`, `pi-live/`, `summary.json` and `summary.md` under `--out`.

| Side | What it reads | How exact |
|---|---|---|
| Prime | `<agent dir>/browser-chat/prompts/<session>.json`, which the legacy chat's user-history extension writes from `before_provider_request` on every request (`legacy/prime/user-history/src/prompt-capture.ts`). By default the newest capture of a chat listed in `browser-chat/chats.json`. | The payload as sent on the wire, after every extension. No Prime process is started. |
| Builder | `packages/pi-host/src/durable/prime-prompt.ts` for the capture's cwd, session file and pinned brief (the session's last `chat_brief` entry since its last compaction), and the capture's Prime release for bundled skills when it is still on disk | The text a pi thread gets for the same inputs |
| pi today | The newest thread under `<agent dir>/pi-host/durable/threads/`, opened with `?mode=ro`; its root conversation's `pi.system` entries replayed | The sections and tools that thread's file holds now |

A Prime session file does not store the system prompt, so the capture is the only exact record of it.
The capture holds the identity block `You are Claude Code, Anthropic's official CLI for Claude.` first; pi-ai's Anthropic provider sends the same block for a subscription token.

## Section by section

Bytes are from Prime chat `01a1180e` (VP of CI) at 18:05 UTC on 2026-10-28, cwd `auto-sns-agent`.

| # | Section | Source in Prime | Prime sends it as | Bytes | pi before | pi now |
|---|---|---|---|---|---|---|
| 1 | `preamble` | prime-agent `buildRlmPrompt` (`core/prompts/rlm.js`): base prompt, nonblocking work, progress updates, simplified English, working directory, conversation log, depth, Python skill modules, `rlm` and REPL rules | system prompt | 11,139 | different: its first 3 lines only (268 bytes) | identical |
| 2 | `delegation` | `buildSubagentGuidance` | system prompt | 1,317 | no | identical |
| 3 | `mcp` | `formatGenericMcpGuidance`, `settings.json` `mcpServers` | system prompt | 382 | no | identical |
| 4 | `guidance` | "# Additional Guidance": the `chat_board` tool's promptGuidelines (`CHAT_BRIEF` in `legacy/prime/user-history/src/chat-brief.ts`) and the `poteto_mode` line (`personaGuideline`); for a job, `jobReplyGuideline` and the poteto line | system prompt | 14,711 | no | identical |
| 5 | `context` | "# Project Context": `~/.prime/agent/AGENTS.md` (from `config/AGENTS.md`), then AGENTS.md or CLAUDE.md of the cwd and each folder above it (Prime's `loadProjectContextFiles`) | system prompt | 13,298 | no | identical |
| 6 | `skills` | `formatSkillsForPrompt` over Prime's loaded skills: `~/.prime/agent/skills/*` (from `skills/`) and the release's bundled skills, filtered by `settings.json` | system prompt | 10,388 | no | identical |
| 7 | `rules` | claude-rules (`packages/pi-claude-rules`): the cwd repo's unscoped `.claude/rules/*.md` | first user message of every request | 52,028 | no | identical text, in the system prompt |
| 8 | `harness` | Prime's harness digest (`formatHarnessStateForPrompt`) over `~/.prime/agent/harness` | `[harness-digest]` message at the session's first turn, then `[harness-digest update]` messages | 10,011 (Prime: 39,955) | no | different, see below |
| 9 | `corrections` | `ledgerPrompt` over `browser-chat/corrections.json` (`chat-corrections.ts`), or `jobLedgerPrompt` for a job | `[corrections]` user message, once per context | 21,750 (Prime: 21,418) | no | same rules; pi lists the 1 correction added since that chat's snapshot |

Sections 1 to 6 joined with a blank line are the exact string Prime's `buildSystemPrompt` returns.
Sections 7 to 9 follow them in the system prompt, because pi-durable can add text only as sections or as hooks that are not stored.

The harness section differs from Prime's for two reasons:

1. Prime merges the session's own local harness entries into the digest, and a pi thread has none.
2. Prime ranks entries by the newest four messages and the goal and shows six per kind. pi ranks by the owner's newest message when the section is first built.

## Tools

| Prime tool or module | Where Prime has it | pi equivalent | Status |
|---|---|---|---|
| `ipython`, the persistent Python REPL | tool | `bash`, `read`, `write`, `edit` | missing; the prompt still describes it |
| `bash()` handles and the nonblocking control loop | REPL | `bash` tool, blocking with a timeout | different: no background handle and no completion follow-up |
| `rlm.spawn`, `list_subagents`, `collect`, `progress_note`, `delete_subagent` | REPL | `subagent {task}`, foreground, returns the answer | different: one blocking child per call, no names or handles |
| `rlm.create_session` | REPL | none (the chat creates threads with `durable_create`) | missing |
| `rlm.harness.*`, `refine.run()` | REPL, `refine` skill | none; pi reads the global harness but writes nothing | missing |
| `tell_owner` | user-history tool | `send_message {text, to?}` | equivalent under another name; the brief still says `tell_owner` |
| `chat_board` | user-history tool | none in pi-host; apps/chat keeps the board in the `chat.board` doc | missing |
| `correction_add` | user-history tool | none | missing; the pi-host canary may not write the ledger anyway (`SHARED_LEDGER_REFUSAL`) |
| `search_history` | user-history tool | none (pi-host has the `durable_search` command, not a tool) | missing |
| `poteto_mode`, `job_reply` | tools that only carry a guideline | the same lines in `guidance` | text identical |
| `agent_message.send` | Python skill | `send_message` reaches people; inbound agent messages are `agent.message` entries; no agent-to-agent send | missing for agent to agent |
| `agent_observe` | Python skill | none | missing |
| `board` (`board.wake`, `board.corrections`, `board.own`) | Python skill | none; its CLI is not on pi's PATH | missing |
| `edit` | Python skill | `edit` tool | equivalent |
| `attach_image` | Python skill | `read` returns an image file as an image | equivalent |
| `goal`, `compact`, `rlm_heartbeat` | Python skills | none (pi-durable compacts by itself) | missing |
| `websearch`, `aside_browser`, the `mcp` object for `aside` | Python skills and REPL | none; `websearch` and `attach_image` CLIs exist in `~/.prime/agent/kernel-venv/bin`, which is not on pi's PATH | missing |
| markdown skills (`unslop`, `how`, `why`, `spec-report`, `setup-pstack`, `typescript-best-practices`, `resume-paused-sessions`, `skill-creator`, `mcp`) | read with ipython | read with `read` at the same `<location>` | equivalent |
| none | | `subagent`, `send_message` | pi only |

## What pi-host does now

| File | Change |
|---|---|
| `packages/pi-host/src/durable/prime-prompt.ts` | The builder and the `prime-prompt` extension. It calls prime-agent's `buildSystemPrompt`, `DefaultResourceLoader`, `formatSkillsForPrompt` and harness formatter from the installed `prime-agent` package, and imports `CHAT_BRIEF`, `personaGuideline`, `jobReplyGuideline`, `ledgerPrompt` and `jobLedgerPrompt` from the legacy chat and `SessionRules` from pi-claude-rules. No Prime text is retyped. |
| `packages/pi-host/src/durable/registry.ts` | `threadRegistry(prompt?)` installs `prime-prompt` in place of the 3-line `Preamble` when it gets prompt options. |
| `packages/pi-host/src/durable/threads.ts` | `DurableThreadsOptions.prompt`; each thread file gets its own registry, so "Conversation log:" names its file, a child names its chat, and the owner's newest text ranks the digest. |
| `packages/pi-host/src/main.ts` | Passes `prompt: {agentDir}` from `--agent-dir`. `PI_HOST_PROMPT_TOOLS=pi` switches the tools profile. |
| `scripts/prompt-parity.mjs` | The capture and comparison above. |
| `packages/pi-host/test/durable/prime-prompt.test.ts`, `test/fixtures/prime-agent/` | The tests below. |

The root conversation of a thread is a Prime chat root (depth 0, the chat brief).
A subagent's child conversation is a chat's job: depth 1, "You are a child agent spawned by <thread name>", `jobReplyGuideline` and the poteto line, no brief and no progress-update paragraph, and `jobLedgerPrompt` for corrections.

Three details keep the bytes equal:

1. Prime runs as a Bun binary, whose readdir keeps directory order, while Node sorts names. The builder walks each skills folder with `opendir` and puts the skills back in directory order.
2. Bundled skills come from the release `~/.local/share/prime-agent/bin/prime-agent` points to, so `<location>` names the same paths. A running Prime chat keeps the release it started on, so right after a Prime update the two differ in that path until the chat reloads.
3. The `prime` tools profile tells Prime's builder a chat's tools (`ipython`, `chat_board`, `tell_owner` and so on), because the builder gates text on them.

## Caching and what changes when a file changes

No section holds a time or a date: Prime's default prompt has none, and only its custom-prompt branch, which neither side uses, adds "Current date".
pi-durable renders every section before each request and writes a `pi.system` entry only for a section whose text changed.
`claude-opus-5-5` accepts system messages mid-conversation, so a changed section goes as `Updated system prompt section "<key>"` after the history, and the cached prefix stays.
A model without that support gets the whole system prompt rebuilt, which is one full cache write.

| Change | Sections sent again | Prime |
|---|---|---|
| A global or repo AGENTS.md or CLAUDE.md | `context` | read at session start and on reload |
| A skill added, removed or its description changed | `skills`, and `preamble` when a Python skill's import name list changes | read at session start and on reload |
| `settings.json` (`mcpServers`, `skills`, `bundledSkills`) | `mcp`, `skills`, `preamble` | at session start |
| A Prime release update | `skills` (bundled paths) | after the session reloads |
| The cwd | `preamble`, `context`, `rules` | |
| A thread rename | a child conversation's `preamble` (its `guidance` is pinned) | |
| The chat brief, the poteto line, the harness, the corrections ledger | none: these are pinned to the text the conversation first got | brief and corrections pinned until compaction; digest updates as deltas |
| `.claude/rules` | none until pi-host restarts (read once per repo, as claude-rules reads it once per session) | once per session |

The builder keeps what it loaded until a file it read changes. It checks about 100 file stamps per request, and a request with pinned sections builds in about 3 ms.
A thread from before this change keeps its first system message, the old preamble, and gets every new section in one update at its next request.

## Remaining gaps and decisions

| Gap | Recommendation |
|---|---|
| The prompt describes `ipython`, `rlm.*`, Python skills and `tell_owner`, which a pi thread lacks. | Decide between the default `prime` profile, which keeps the text identical as asked, and `PI_HOST_PROMPT_TOOLS=pi`, where Prime's own builder drops the REPL parts (the preamble shrinks from 11,139 to 3,277 bytes and the delegation and MCP sections go). The lasting fix is to give pi the tools: a Python REPL tool on pi-rlm's kernel, `chat_board`, `correction_add` and an agent-to-agent message tool. |
| The brief says `tell_owner`, pi has `send_message`. | Name the tool `tell_owner` in pi, or let the brief name the tool the runtime has. Either keeps one text for both. |
| Prime sends `rules`, the digest and corrections as messages; pi puts them in the system prompt. | Keep it: the text is the same, and a system section keeps the cache when it changes. |
| The digest has no local entries and no later updates. | Add pi's own local harness store, or accept global memories only. |
| A job's corrections block misses the brief-dependent lines (`uiRuleLine`, `tokenCostRuleLine`), because a section cannot see the child's task. | Pass the task to the child through a document when the subagent tool creates it. |
| A job's `jobReplyGuideline` names a `~/scratch/<thread>-<conversation>` folder that nothing deletes, and tells it to report with `agent_message.send`, while a pi child answers with its final text. | Keep the text; add the cleanup when pi jobs become threads of their own. |
| Skill CLIs are not on pi's PATH. | Add `~/.prime/agent/kernel-venv/bin` to the PATH of `NodeExecutionEnv`, after checking each CLI runs outside the kernel. |
| `apps/chat/server/agent-config.ts` still reports the system text as `PRIME_BASE_PROMPT`. | Point it at the builder once this lands. |
| pi-host imports from `legacy/prime/user-history/src` and the root `prime-agent` package. | Both ship in every pi-host release (a whole-repo export). Move `chat-brief.ts` and `chat-corrections.ts` to a package when the legacy chat goes. |

## Tests

`packages/pi-host/test/durable/prime-prompt.test.ts` builds from the fixture agent dir in `test/fixtures/prime-agent`:

1. The sections come in Prime's order, each with its source's text.
2. The Prime sections are byte for byte what prime-agent's `buildSystemPrompt` returns for the same skills, AGENTS.md files and guidelines, for a chat, a job and the `pi` profile.
3. A thread keeps its prompt across turns with no new `pi.system` entry; a changed AGENTS.md sends only `context`, the first system message stays the same, and the pinned digest and corrections stay; a child conversation gets a job's prompt.
4. `DurableThreads` with `prompt` names the thread file as the conversation log, and the owner's words rank the digest.

The real comparison against Prime's captured requests is `scripts/prompt-parity.mjs`, because the captures hold private session text and cannot be a fixture.

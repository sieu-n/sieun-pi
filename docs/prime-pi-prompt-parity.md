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

A thread's root conversation now runs Prime's own chat extension, `legacy/prime/user-history/extension/index.ts`, through an adapter (`packages/pi-host/src/durable/pi-extensions.ts` and `prime-chat.ts`).
pi-host loads the extension once at start as a Prime chat (flags `chat` and `owner-thread`) and fires its `session_start`, so it registers what a Prime chat's session gets.
Each registered tool becomes a pi-durable tool with the extension's own name, description and parameters, in the order a Prime chat's request lists them.

On 2026-10-28 at 18:35 UTC `scripts/prompt-parity.mjs` compared every tool of Prime chat `01a11af8`'s captured request with what pi-host offers, as pi-ai's Anthropic provider sends it (name, description, `input_schema`):

| Prime tool or module | Where Prime has it | pi equivalent | Status |
|---|---|---|---|
| `search_history` | user-history tool | the same tool, the extension's own execute (pi-history's socket) | identical definition (484 bytes); replay-safe |
| `chat_board` | user-history tool | the same tool on apps/chat's board, check-in and agents API for the thread | identical definition (182 bytes); output in Prime's words |
| `tell_owner` | user-history tool | the same tool with Prime's live guard | identical definition (3,445 bytes); replay-safe |
| `correction_add` | user-history tool | the same tool, the extension's own execute, on the shared ledger | identical definition (160 bytes) |
| `poteto_mode` | user-history tool that carries a guideline | the same tool | identical definition (38 bytes) |
| `job_reply` | user-history tool of a chat's job | none; a child conversation gets its guideline in `guidance` | missing tool, text identical |
| `ipython`, the persistent Python REPL | pi-rlm tool | `bash`, `read`, `write`, `edit` | missing; the prompt still describes it, see below |
| `bash()` handles and the nonblocking control loop | REPL | `bash` tool, blocking with a timeout | different: no background handle and no completion follow-up |
| `rlm.spawn`, `list_subagents`, `collect`, `progress_note`, `delete_subagent` | REPL | `subagent {task}`, foreground, returns the answer | different: one blocking child per call, no names or handles |
| `rlm.create_session` | REPL | none (the chat creates threads with `durable_create`) | missing |
| `rlm.harness.*`, `refine.run()` | REPL, `refine` skill | none; pi reads the global harness but writes nothing | missing |
| `agent_message.send` | Python skill | inbound agent messages are `agent.message` entries; no agent-to-agent send | missing for agent to agent |
| `agent_observe` | Python skill | none | missing |
| `board` (`board.wake`, `board.corrections`, `board.own`) | Python skill | `chat_board` for the board; no wakes | missing outside `chat_board` |
| `edit` | Python skill | `edit` tool | equivalent |
| `attach_image` | Python skill | `read` returns an image file as an image | equivalent |
| `goal`, `compact`, `rlm_heartbeat` | Python skills | none (pi-durable compacts by itself) | missing |
| `websearch`, `aside_browser`, the `mcp` object for `aside` | Python skills and REPL | none; their CLIs in `~/.prime/agent/kernel-venv/bin` are not on pi's PATH | missing |
| markdown skills (`unslop`, `how`, `why`, `spec-report`, `setup-pstack`, `typescript-best-practices`, `resume-paused-sessions`, `skill-creator`, `mcp`) | read with ipython | read with `read` at the same `<location>` | equivalent |
| none | | `read`, `write`, `edit`, `bash`, `subagent`, `send_message` | pi only |

The tool list a pi chat thread offers is `read, write, edit, bash, subagent, send_message, search_history, chat_board, tell_owner, correction_add, poteto_mode`; a Prime chat's is `ipython, search_history, chat_board, tell_owner, correction_add, poteto_mode`.
A subagent's child conversation offers `read, write, edit, bash` and none of the chat's tools, as a Prime job has no `tell_owner`.

### How each chat tool runs in a thread

| Tool | Runs | Store | Replay after a restart |
|---|---|---|---|
| `search_history` | the extension's execute, with the thread id as the caller | pi-history's socket, as in Prime | safe: it only reads |
| `chat_board` | Prime's `parseBoardOps`, its c43, c72 lane-hold and hold-ask flags, `chatCheckIn`, `checkInLine`, `renderOpenPlan`, `boardRevLine` and `agentLines` | apps/chat (`PI_HOST_CHAT_URL`, default `http://127.0.0.1:5184`): `POST /api/threads/<thread>/board {ops, actor: "agent"}`, which now answers each op's summary, `GET .../board`, `GET`/`POST .../check-in`, `GET .../agents`; a read falls back to the thread's `chat.board` document when the chat server does not answer. Never the legacy `browser-chat/boards`. | unsafe: a rerun would apply the ops twice, so an interrupted call gets pi-durable's `interrupted` result |
| `tell_owner` | Prime's live guard (`liveGuard`: `tellTurn`, `tellOwner`, `askedTodos`, the same file a Prime chat loads), over the thread's messages up to the call | the board's asked todos from apps/chat, and on a decision or blocker the other chats' open asks from apps/chat's For you list | safe: nothing leaves the thread; the message is the call's `text` |
| `correction_add` | the extension's execute | the ledger Prime chats share: `AGENT_CHAT_SHARED_DIR` (pi-host's unit sets it to `~/.prime/agent/browser-chat`), or the chat host's corrections route when hosts.json names another box | unsafe: a rerun could record it twice |
| `poteto_mode` | the extension's execute | none | safe |

A throw from any of them is an error result whose text is the error's message, as pi's agent loop sends it, without pi-durable's `<harness>` wrapper.

Three differences remain in what these tools do:

1. apps/chat keeps no `pausedBy`, so every check-in pause reads as the owner's, which Prime's rule lets no agent lift. A chat that paused its own check-in cannot resume it until apps/chat records who paused.
2. The c43 limit-claim flag leaves out the job names of this board's steps; Prime leaves out the job names of every legacy board (`jobNames`).
3. `correction_add`'s answer says the service refines the global harness when the turn ends (`AUTO_REFINE`); the legacy chat service does that for its own chats only, so nothing refines after a thread's turn yet.

### `tell_owner` and `send_message`

`tell_owner` is the tool the brief names and the one a thread speaks to the owner through, with Prime's guard: a turn the owner did not start needs `why` and `about`, an `update` there is kept as a note, and the reply lints run.
apps/chat draws a `tell_owner` call exactly as a `send_message` call (one constant, `SPEAKING_TOOLS` in `apps/chat/server/timeline.ts`, used by the timeline, the live page, channels, duty reports and search), and draws a held call as a note in the fold, as Prime's feed does.

`send_message` stays beside it as an alias, with the same result and a description that points to `tell_owner` (`SendMessageAlias`).
Dropping it now would break two things apps/chat still asks for by name: a channel post's reply (`channels.ts` tells the agent "what you send with send_message is posted back into this thread") and a duty job's report (`duty-run.ts` "Send it with send_message"), and Prime's guard would hold both, since neither turn is the owner's.
Remove the alias once those two texts name `tell_owner` and the guard knows a channel turn.
A host without the chat extension (`PI_HOST_PRIME_CHAT=0`, or a failed load, which pi-host logs) offers the old `send_message` with its old description.

### Turn wrappers

The extension's context hook runs as a pi-durable `beforeRequest` hook of the root conversation, with Prime's own `withMessageIds` and `withWakeNotes`, in that order.
The hook reads the conversation's entries to tell who sent each input: a `pi.user` entry and an `agent.message` from `owner` are the owner's and get `[message id: <id>; reply_to it only after he sends a newer message]`; any other `agent.message` (a check-in, a wake, a duty report, another agent, a channel post by an agent) is Prime's `agent_message` and gets the `[not from the owner: ...]` note.
The notes go only into the request; the entries keep the raw text, and each note depends only on its message, so the cached prefix holds.

| Wrapper | Source | pi now |
|---|---|---|
| `[message id: ...]` | `withMessageIds` (chat-guard.ts) | identical, on each owner input |
| `[not from the owner: ...]` | `withWakeNotes` (chat-guard.ts) | identical, on each input from anyone else |
| `[corrections]` | `deliverCorrections` (correction-delivery.ts) | not added again: `prime-prompt.ts` sends the same `ledgerPrompt` text as the pinned `corrections` section |
| `[correction check]` | the legacy chat server (`chats.ts` `correctionStep`), not the extension | missing; apps/chat would have to send it |

### What a running thread sees at the first request after the release

1. A `pi.system` update that adds the five chat tools and replaces `send_message`'s description. pi-durable sends it after the history, so the cached prefix stays on a model that takes system messages mid-conversation.
2. Every earlier owner input in the history now carries its `[message id]` note and every earlier input from anyone else its `[not from the owner]` note in the request, so that first request writes the whole history to the cache once; later requests keep it.
3. A child conversation a subagent call made before this release stored only `remove: ["subagent", "send-message"]`, so if it runs again it is offered the chat's tools too (without the wrappers, which run only in the root). A child made from now on drops `prime-chat` as well.

### What the adapter skips, and why

| Part of the extension | Reason |
|---|---|
| The first context hook: notice rewording for cancelled and parked rlm children, the image fitter | A thread has no rlm child notices; pi-durable's `read` fits images. |
| `before_provider_request`: the prompt capture and a child's parent label | pi-host has no Prompt view for threads; a durable child's label is in its `preamble`. |
| `tool_call`, `tool_result`: ipython code rewrites, the job registry, load-wait notes, the moved-session block | They act on `ipython` and Prime's job registry, which a thread lacks. |
| `before_agent_start`, `session_compact` | They find a job's chat in Prime session files and re-pin the brief; the brief pin is the `guidance` section's. |
| `job_reply` | Registered only for a session whose parent is a Prime chat session file. |
| `registerCommand` (`what-did-i-say`, `agent-chat`), `registerFlag`, `appendEntry` | They open the legacy chat or write Prime session entries; the adapter records them (`skipped`, `appended`). |

### `ipython`, the RLM kernel and agent-bus

These are not in pi threads yet, and pi threads keep `bash`, `read`, `write` and `edit`.
The base prompt Prime's builder writes for the `prime` tools profile still describes `ipython`, `rlm.*` and the Python skill modules, so a pi thread reads about a REPL it does not have.
pi-rlm's `ipython` tool (`packages/pi-rlm/src/pi/index.ts`) could load through the same adapter, but it depends on more than a tool:

1. Its kernel is a child process keyed by the pi session and dies with pi-host. A call a restart interrupts would get `interrupted` (it cannot be replay-safe), and the next call starts a fresh kernel; pi-rlm revives state only at a pi `session_start`, which a thread has no equivalent of.
2. `rlm.spawn` and `rlm.create_session` create Pi sessions through pi-host's non-durable host, not child conversations, so their children would not be in the thread file and would not resume with it.
3. The nonblocking loop (`bash()` handles, completion follow-ups, `rlm_heartbeat`, goals) runs on pi's `agent_before_settle`, `agent_settled` and `turn_end` events; pi-durable has `onYield` and `afterTools`, which would need a mapping of their own.
4. agent-bus delivers agent messages into a Pi session's queue; a thread takes them as `agent.message` inputs through `durable_submit`.

Recommendation: keep `bash` in pi threads for now, and decide between the `prime` tools profile (text identical to Prime, describing a REPL pi lacks) and `PI_HOST_PROMPT_TOOLS=pi` (Prime's own builder drops the REPL parts). A durable `ipython` needs a kernel per conversation that pi-host restarts on the thread's next call with the revive step, `rlm.*` mapped to child conversations, and the settle events mapped to pi-durable hooks.

### Harness memories

The `harness` section is Prime's own `formatHarnessStateForPrompt` over the global store, as before.
pi-harness (`packages/pi-harness/src/pi/index.ts`) keeps a local store per Pi session file and refines it after runs (`agent_settled`, kernel `refine.run`), which a thread cannot drive yet, so the section still lacks local entries and later `[harness-digest update]` messages.

## What pi-host does now

| File | Change |
|---|---|
| `packages/pi-host/src/durable/pi-extensions.ts` | The adapter: loads a pi coding-agent extension with a recording `ExtensionAPI`, keeps its tools, handlers and flags, fires its events with a pi context that answers with the thread's ids, name, file and cwd, and turns each tool into a pi-durable tool with its own definition and a replay policy. |
| `packages/pi-host/src/durable/prime-prompt.ts` | The builder and the `prime-prompt` extension. It calls prime-agent's `buildSystemPrompt`, `DefaultResourceLoader`, `formatSkillsForPrompt` and harness formatter from the installed `prime-agent` package, and imports `CHAT_BRIEF`, `personaGuideline`, `jobReplyGuideline`, `ledgerPrompt` and `jobLedgerPrompt` from the legacy chat and `SessionRules` from pi-claude-rules. No Prime text is retyped. |
| `packages/pi-host/src/durable/prime-chat.ts`, `chat-app.ts` | The user-history extension as a thread's `prime-chat` extension: its tools with their bindings, the turn wrappers hook, and the apps/chat client. |
| `packages/pi-host/src/durable/registry.ts` | `threadRegistry(prompt?, chat?)` installs `prime-prompt` in place of the 3-line `Preamble` when it gets prompt options, and `prime-chat` with the `send_message` alias when it gets the chat. |
| `packages/pi-host/src/durable/threads.ts` | `DurableThreadsOptions.prompt`; each thread file gets its own registry, so "Conversation log:" names its file, a child names its chat, and the owner's newest text ranks the digest. |
| `packages/pi-host/src/main.ts` | Passes `prompt: {agentDir}` from `--agent-dir`. `PI_HOST_PROMPT_TOOLS=pi` switches the tools profile. Loads the chat extension at start; `PI_HOST_PRIME_CHAT=0` leaves it out. |
| `apps/chat/server/timeline.ts`, `threads.ts`, `search-snippet.ts`, `boards.ts` | `SPEAKING_TOOLS`: a `tell_owner` call is drawn, previewed, posted and searched as a `send_message` call; a held one is a note. The agent's board write answers its summaries. |
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
| The prompt describes `ipython`, `rlm.*` and Python skills, which a pi thread lacks. | Decide between the default `prime` profile, which keeps the text identical as asked, and `PI_HOST_PROMPT_TOOLS=pi`, where Prime's own builder drops the REPL parts (the preamble shrinks from 11,139 to 3,277 bytes and the delegation and MCP sections go). The lasting fix is a durable `ipython` (see above) and an agent-to-agent message tool. |
| `send_message` beside `tell_owner`. | Move apps/chat's channel and duty texts to `tell_owner`, teach the guard a channel turn, then drop the alias. |
| No `[correction check]` after an owner message that reads as a correction. | Port the legacy server's `correctionStep` to apps/chat. |
| Prime sends `rules`, the digest and corrections as messages; pi puts them in the system prompt. | Keep it: the text is the same, and a system section keeps the cache when it changes. |
| The digest has no local entries and no later updates. | Add pi's own local harness store, or accept global memories only. |
| A job's corrections block misses the brief-dependent lines (`uiRuleLine`, `tokenCostRuleLine`), because a section cannot see the child's task. | Pass the task to the child through a document when the subagent tool creates it. |
| A job's `jobReplyGuideline` names a `~/scratch/<thread>-<conversation>` folder that nothing deletes, and tells it to report with `agent_message.send`, while a pi child answers with its final text. | Keep the text; add the cleanup when pi jobs become threads of their own. |
| Skill CLIs are not on pi's PATH. | Add `~/.prime/agent/kernel-venv/bin` to the PATH of `NodeExecutionEnv`, after checking each CLI runs outside the kernel. |
| `apps/chat/server/agent-config.ts` still reports the system text as `PRIME_BASE_PROMPT`. | Point it at the builder once this lands. |
| pi-host imports from `legacy/prime/user-history/src` and the root `prime-agent` package. | Both ship in every pi-host release (a whole-repo export). Move `chat-brief.ts` and `chat-corrections.ts` to a package when the legacy chat goes. |

## Tests

`packages/pi-host/test/durable/prime-chat.test.ts` runs the real user-history extension through the adapter against a fake apps/chat server:

1. The extension registers a Prime chat's five tools, and their promptGuidelines are the lines `prime-prompt.ts` renders as `guidance`.
2. A thread offers them after `read, write, edit, bash, subagent, send_message`, each equal to the definition the extension registered.
3. An owner input reaches the model with `messageIdNote(<its time>)` and a check-in with `WAKE_NOTE`, while the entries keep the raw text.
4. `tell_owner` answers `told the owner` on the owner's turn, refuses a call with no `why` on a check-in, and holds an `update` there.
5. `chat_board` posts the ops to apps/chat as the agent and returns Prime's summary and open-plan lines.
6. `correction_add` writes `corrections.json` in the shared dir with the thread as the chat.
7. A subagent's child conversation gets none of the chat's tools and no wrappers.

`apps/chat/test/server/send-message.test.ts` checks that a `tell_owner` call renders, previews and searches like a `send_message` call, and that a held one is a note.

`packages/pi-host/test/durable/prime-prompt.test.ts` builds from the fixture agent dir in `test/fixtures/prime-agent`:

1. The sections come in Prime's order, each with its source's text.
2. The Prime sections are byte for byte what prime-agent's `buildSystemPrompt` returns for the same skills, AGENTS.md files and guidelines, for a chat, a job and the `pi` profile.
3. A thread keeps its prompt across turns with no new `pi.system` entry; a changed AGENTS.md sends only `context`, the first system message stays the same, and the pinned digest and corrections stay; a child conversation gets a job's prompt.
4. `DurableThreads` with `prompt` names the thread file as the conversation log, and the owner's words rank the digest.

The real comparison against Prime's captured requests is `scripts/prompt-parity.mjs`, because the captures hold private session text and cannot be a fixture.

# Durable threads

pi-host's durable side runs each root thread on `@earendil-works/pi-durable` 1.4.0.
A thread is one SQLite file, `<durable dir>/threads/<id>.sqlite`, holding the root conversation, every child conversation its subagents create, and their entries, tasks and documents.
A crash, an OOM kill or a restart loses nothing that was admitted: the next pi-host reopens the file, and each run, tool call, child task and sleep continues from its last checkpoint.

## How a restart resumes work

```mermaid
sequenceDiagram
participant C as chat
participant H as pi-host
participant I as index.sqlite
participant T as threads/<id>.sqlite
C->>H: durable_submit {thread, text, requestId}
H->>I: mark the thread active
H->>T: admit the input in one commit
T-->>H: onWake {active}
Note over H,T: SIGKILL mid-turn
H->>I: (new process) threads marked active or due
H->>T: open, resume()
T-->>H: the run continues from its checkpoint
C->>H: durable_submit with the same requestId
H-->>C: the same submission, nothing admitted twice
```

1. pi-host marks a thread active in `index.sqlite` before it admits an input, and the Harness's `onWake` keeps the mark current after each commit, so a crash between the two still reopens the file.
2. At start pi-host opens every thread marked active or with a due sleep and calls `resume()`.
3. A thread whose tasks only sleep, such as a pi-pool slot wait, is closed after 10 idle minutes, and one timer for the earliest sleep reopens it when it is due.
   An open file also keeps a timer for its own earliest sleep, because pi-durable arms none once the host takes `onWake`, and a child's turn poll or retry backoff sleeps while the root's subagent call keeps the file active.
4. One pi-host is the only writer of each file, through a lockfile next to it as for Pi session files.
5. A repeated `requestId` returns the first submission, so a client that retries after a restart never doubles an input.

## Files

| Path | What it holds |
|---|---|
| `threads.ts` | `DurableThreads`: open, recover, submit, wait, abort, watch, tree, entries, documents and idle close. |
| `index-db.ts` | `ThreadIndex`: the thread rows, each thread's last wake, the FTS5 search rows and the usage rows, all derived from the thread files. |
| `commands.ts` | `DurableCommands`: the `durable_*` socket commands and the watches per connection. |
| `registry.ts` | What every thread runs with: Prime's prompt (or the preamble alone without an agent dir), pi-durable's coding tools in the thread's cwd, the subagent tool, the `send_message` tool, `agent.message` entries and `chat.doc` documents. |
| `prime-prompt.ts` | A Prime chat's system prompt, built by prime-agent's own `buildSystemPrompt` from the agent dir's AGENTS.md files, skills, chat brief, harness and corrections ledger, as pi-durable sections; `docs/prime-pi-prompt-parity.md` maps each part. |
| `open.ts` | `openDurableHost()` for one file and the Prime preamble extension. |
| `@sieun-pi/pi-pool/durable` | `poolProvider()` in `packages/pi-pool/src/durable/pool-provider.ts`: a pi-ai Provider that vends each request's account through pi-pool and turns a slot wait into a stored sleep. |
| `subagent.ts` | The `subagent` tool: a replay-safe call that owns one child conversation and returns its answer. |
| `send-message.ts` | The `send_message` tool, the one way an agent speaks to people: `{text, to?}`, result "Sent.", no effect outside the thread. |
| `import.ts` | `parseSession()`: a Prime or Pi session file's active branch as entry drafts, for `durable_import`. |

## Socket commands

Each command is one JSON line with `type` and `id`, and the response is a v7 `response` line.

| Command | Fields | Data |
|---|---|---|
| `durable_threads` | `archived?` | `threads`: id, name, provider, modelId, cwd, createdAt, updatedAt, status (idle, running, sleeping, failed), wakeAt, preview, children. |
| `durable_create` | `name?`, `model?` ("provider/id"), `thinkingLevel?`, `cwd?` | `thread` |
| `durable_submit` | `thread`, `conversation?`, `text?`, `images?` ({data, mimeType}), `requestId?`, `whenBusy?` (steer, followUp, reject), `entry?` ({kind: "agent.message", data: {from, via?}}), `ownerTurn?` | `submission`, `requestId`, `status`, `ticket` ({session, tree, place}), `owner?` ({state: marked, off or failed, ahead?}) |
| `durable_ticket` | `thread`, `conversation?` | `ticket`: the conversation's run in pi-pool's turn queue, read from `turns.json`. |
| `durable_wait` | `thread`, `submission` | `settled`: the submission record once done or unanswered. |
| `durable_watch` | `thread`, `conversation?`, `fromEntry?` | `watch`; then `durable_event` lines. |
| `durable_unwatch` | `watch` | `stopped` |
| `durable_abort` | `thread`, `conversation?` | |
| `durable_tree` | `thread` | `conversations`: id, parent, ownerTask, name, depth, status, model, createdAt. |
| `durable_entries` | `thread`, `conversation?`, `before?`, `after?`, `limit?` | `entries` newest first (oldest first with `after`), `more`. |
| `durable_search` | `q`, `threads?`, `conversation?`, `from?` (author), `by?` ({thread, conversation, id}: what one agent said), `skipAgentMessages?` (a LIKE pattern for agent messages to leave out), `notFrom?` (an author to leave out), `kinds?` and `skipKinds?` (entry kinds to keep or leave out), `demoteKinds?` (kinds that rank after every other match in relevance order), `after?`, `before?`, `limit?`, `offset?`, `sort?` (relevance, recent) | `hits`: one page of thread, conversation, entryId, kind, author, at, snippet with `<mark>`; `total`: the exact count of every match. Copies of one entry (same entry id, kind, author and time) count and show once, from the unarchived, newest thread. |
| `durable_usage` | `since?`, `until?`, `threads?` | `usage`: per thread and model, turns, input, output, cacheRead and cacheWrite tokens, and cost with costInput, costOutput, costCacheRead and costCacheWrite apart. |
| `durable_doc_get` | `thread`, `name`, `conversation?` | `value` |
| `durable_doc_put` | `thread`, `name`, `value`, `conversation?` | |
| `durable_set` | `thread`, `name?`, `model?`, `thinkingLevel?`, `archived?` | `thread` |
| `durable_import` | `path` (a Prime or Pi session JSONL), `name?`, `model?`, `cwd?` | `thread` with `imported` and `skipped` counts. |

A `durable_event` line is `{type: "durable_event", thread, watch, event}`, and `event` is one of these.

1. `{type: "events", conversation, events}` carries pi-durable's agent events for one conversation, starting with a `snapshot` without its entries, then `entry_appended` for each entry after `fromEntry`, then every later batch.
2. `{type: "conversation", node}` says a subagent created a child conversation, and a watch on the whole file attaches to it.
3. `{type: "status", status, wakeAt?}` follows the thread's wake.
4. `{type: "doc", conversation, name, value}` follows `durable_doc_put`.
5. `{type: "closed", reason}` ends the watch when the file closes at shutdown.

Every entry reaches a watcher once, so a client that reconnects with `fromEntry` set to the newest id it has misses nothing.

## Speaking through send_message

Every root thread has `send_message {text, to?}`, and its description carries the rules for talking to people (`SEND_MESSAGE_DESCRIPTION`).

1. The call does nothing outside the thread and returns "Sent.", so it is replay-safe: the call's arguments in the assistant entry are the message.
2. The chat (`apps/chat/server/timeline.ts`) draws each call's text as its own bubble and folds the rest of the turn's text, as private notes, with its thinking and tool steps; a channel turn posts one reply per call. A conversation that has never called it keeps its turn text as the bubble.
3. `to` is only for a turn a channel post started, and names that channel; the chat posts a call aimed at another channel nowhere.
4. A subagent's child conversation is not offered the tool, because its parent reads its final text as the answer.
5. The thread list's preview is the newest sent message, never its "Sent." result.
6. Pi-durable stores extension names, not tools, and every conversation selects every installed extension unless it says otherwise, so a thread whose history predates the tool is offered it from its next model request on, through a new `pi.system` entry; `test/durable/send-message.test.ts` checks this on a file first run without the tool. A child created before this change stored only `remove: ["subagent"]` and is offered the tool too.

## Importing a Prime thread

`durable_import {path}` reads a Prime or Pi session file and writes its active branch into a new thread, and the old file is only read.

1. User, assistant and tool-result messages become `pi.user`, `pi.assistant` and `pi.tool-result` entries.
2. A compaction becomes a `pi.compaction` entry whose head is the entry its first kept line became, so the model sees the summary and the kept messages, as Prime sent them.
3. Prime's custom messages, such as agent messages, task briefs and heartbeats, become `prime.custom` entries the model reads as user text.
4. The thread takes the session's name, cwd, last model and thinking level.
5. Bookkeeping lines, such as `git_state` and `child_usage_attributed`, are counted in `skipped` and not written.

This job's own Prime transcript of 260 lines imported in 138 ms, and claude-opus-5-5 through pi-pool answered a question about it from the imported context.

## How a request gets its account

```mermaid
sequenceDiagram
participant G as pi.generation task
participant P as poolProvider
participant H as pi-pool-token
participant A as api.anthropic.com
G->>P: streamSimple, sessionId of the conversation
P->>H: --provider anthropic, PI_POOL_SESSION_KEY = the thread's tree
alt token
  H-->>P: sk-ant-oat01 token
  P->>A: the request, through pi-ai's anthropic provider
  A-->>G: the stream; a 429 goes to pi-pool limited
else exit 75 with retryAt
  H-->>P: slot wait
  P-->>G: stopReason deferred, pollAfterMs up to 30 s
  G->>G: commit a sleep until pollAt (survives a restart)
  G->>P: fetchDeferred at pollAt
  P-->>G: still waiting: deferred again; slot open: a retryable error
  G->>P: retry with a fresh vend
end
```

1. One thread is one pool tree: `PI_POOL_SESSION_KEY` carries `pi-durable:<thread id>` as the root and the conversation's `pi.provider` session id as the active session, so a child conversation draws from the root's account.
2. A poll that finds the slot open ends with a retryable error, because pi-durable's `fetchDeferred` gets only the handle and not the transcript, so each slot wait costs one attempt of `settings.retry.maxRetries`.
3. Each request first takes its run's place in pi-pool's turn queue, the one line every Prime and Pi run on the box waits in, through `TurnQueue` (`admit <session>` under the thread's tree).
4. A queued run is deferred like a slot wait: its stored sleep reads its place in `turns.json` each second and asks again every 30 s, as the pi-pool extension does, and a crash during the wait resumes the poll from the file.
5. When the slot starts, the poll ends with a retryable error and the retry sends the request, so `DURABLE_SETTINGS` gives the retry budget two attempts on top of pi-durable's default, one for the turn wait and one for the slot wait.
6. A working session renews its lease from its requests every 5 minutes, and pi-host releases the slot when the conversation's input settles, with `--queued-input` when a run goes on.
7. A crash drops the host's queue entries once pi-pool sees the process gone, so a resumed run asks again and keeps its place only through pi-pool's own `kept` rules.
8. `durable_submit {ownerTurn: true}` runs `pi-pool owner-turn <session>` before the admit, as the chat does for an owner prompt to Prime, so the run's first ask starts at once as kind `owner` and counts toward `working_max`, and a run of that conversation already queued starts now as kind `ahead`. A run that already holds its slot takes the owner's input as a steer or follow-up, and no mark is set. Every submit first waits for the slot release of the conversation's last settled input, so an input sent right after a settle never reads the ended run as working and never renews a slot that the release then drops.
9. A ticket's `place` is `{state: "working", kind}`, `{state: "queued", position, total}` in pi-pool's order (lead sessions first, then first asked), `{state: "marked"}` for an owner mark the run has not taken yet, or `{state: "none"}` before the run's first ask and after its release. The ticket in `durable_submit`'s answer is read right after the admit, so the run's first ask may come after it; `durable_ticket` reads it again.

## Crash tests

1. `test/durable/host-crash.test.ts` starts a real pi-host in a child process, submits through the socket, sends SIGKILL while the subagent streams, while a pool slot wait sleeps or while the run waits in the turn queue, starts a new pi-host on the same folder and checks through the socket that the host reopened the thread by itself and that the input was answered once, with the child's answer as the tool result, plus search, usage and documents after the restart.
   In the turn-queue case it also checks that no token went out before the admit and that every session that asked gave its slot back.
2. `test/durable/owner-turn.test.ts` runs the real `pool/turns.py` queue in its own `PI_POOL_DIR` with one slot held and two runs queued, and checks that an agent input queues third while an owner input with `ownerTurn: true` is admitted as kind `owner` with no wait and answers, with each ticket over the socket and `durable_usage`'s four costs. `test/durable/owner-turn-settle.test.ts` slows each release by 1 s and checks that an owner input sent right after the last one settled is still admitted as kind `owner` and leaves no mark behind.
3. `test/durable/child-turn.test.ts` runs the real `pool/turns.py` queue with a root whose subagent's first ask queues, gives the child the slot, and checks that the child sends its request and the root answers within 15 s.
4. `test/durable/crash.test.ts` runs the crash cases of item 1 on one file without pi-host, with kills mid root stream, mid child stream and in a slot wait.
5. The crash tests run on the faux provider behind the real pool wrapper and `pi-pool/test/fake-pool.mjs`, and `PI_DURABLE_REAL=1` adds a case on the real `claude-opus-5-5` through pi-pool.

```sh
cd packages
node --import tsx --test --test-force-exit "pi-host/test/durable/*.test.ts"
PI_DURABLE_REAL=1 node --import tsx --test --test-force-exit --test-isolation=none --test-name-pattern="real" pi-host/test/durable/host-crash.test.ts
```

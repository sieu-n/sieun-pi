# apps/chat API

The chat server serves every endpoint under `/api` on 127.0.0.1:5184, one WebSocket at `/api/live`, and the built web client (`web/dist`) for every other path, with `index.html` as the fallback.
Every shape lives in `web/src/lib/api/types.ts`, which the server imports too, so this file names shapes and does not repeat them.
Pages call the server through `web/src/lib/api` (`import { api, timeline, agents } from "$lib/api"`) and never through `fetch` of their own.

## Run it

1. `npm install` in `apps/chat`, once.
2. `npm run fixture` runs the server on 127.0.0.1:5186 with a seeded fake host and a fresh data dir in /tmp, with no pi-host.
3. `npm start` runs it on 127.0.0.1:5184 against pi-host's socket `$XDG_RUNTIME_DIR/pi-host/host.sock` with data dir `~/.pi/agent/chat`.
4. The flags are `--port`, `--listen`, `--data-dir`, `--socket`, `--fixture` and `--web-dir`.
5. `npm test` runs the HTTP specs in `test/server/`, and `npm run typecheck` checks the server and `lib/api`.

## Ids

| Id | Form | Example |
|---|---|---|
| Root thread, and its agent | pi-host thread id | `0f1e0000-0000-4000-8000-000000000001` |
| Job inside a thread, and its agent | `<thread>:<conversation>` | `0f1e...0001:14` |
| Channel | `ch_<id>` | `ch_cutover` |
| Thread item | `e<entry>` for an input, `t<entry of its input>` for a turn | `e12`, `t12` |
| Channel post | `p<seq>` | `p7` |

1. An agent's id is the id of its own conversation, so `/api/c/<agent id>` opens its transcript and a DM with it.
2. The owner's principal id is `owner`.
3. A turn's id is the id of the input it answers, so the live turn keeps one id from the moment the input lands.
4. A pending send is `r:<requestId>` until its real item arrives: an input with its text in a thread, or the post with its `requestId` in a channel.

## Conversations and the sidebar

| Call | Endpoint | Returns |
|---|---|---|
| `api.sidebar()` | `GET /api/sidebar` | `Sidebar`: `solo`, `channels`, `dms` and the open For you count. |
| `api.conversations({archived})` | `GET /api/conversations?archived=1` | `ConversationSummary[]` for every solo thread, DM, job and channel. |
| `api.directory()` | `GET /api/directory` | `{agents, channels}` for the @ and # typeahead. |
| `api.header(id)` | `GET /api/c/:id` | `ConversationHeader`: summary, members, model, the agent, channel purpose and home chat. |
| `api.items(id, {before, after, around, limit})` | `GET /api/c/:id/items` | `TimelinePage`: items oldest first, with `older`, `newer` and `focus` cursors; a thread's newest page ends with its pending sends. |
| `api.replies(channel, root)` | `GET /api/c/:id/replies/:root` | A channel thread: `{root, items}`. |
| `api.send(id, SendRequest)` | `POST /api/c/:id/send` | `SendResult` at once: a thread's pending item `r:<requestId>`, or a channel's post with its deliveries. |
| `api.retrySend(id, requestId)` | `POST /api/c/:id/send/:requestId/retry` | `SendResult`: a failed thread send tries again now. |
| `api.discardSend(id, requestId)` | `DELETE /api/c/:id/send/:requestId` | Drops a failed thread send; its item goes away on every page. |
| `api.abort(id)` | `POST /api/c/:id/abort` | Stops the running turn of that conversation; for a channel, of every member. |
| `api.patch(id, {name, archived, model, thinkingLevel, cwd})` | `PATCH /api/c/:id` | The new header. A job inside a thread takes model changes only. `cwd` moves a root thread to another project folder, and its next request runs there; the server answers 400 for the home folder, a folder above it, a relative path or a missing folder. |
| `api.read(id, seq?)` | `POST /api/c/:id/read` | Sets the owner's read mark. |
| `api.jobs(thread)` | `GET /api/threads/:id/jobs` | `JobNode[]`, the thread's job tree. |
| `api.openDm(agent)` | `POST /api/dms` | Lists that root chat under DMs and returns its summary; a job is returned and stays unlisted. |
| `![alt](/abs/path.png)` in markdown | `GET /api/local-image?path=` | An image file on this box by its absolute or `~/` path: PNG, JPEG, GIF, WebP or SVG up to 25 MiB whose bytes match its type. |

1. A Solo row is a root thread of kind chat, and a DM row is a root chat the owner opened with `openDm`. A root job (a thread started for a chat, such as a duty run's thread), and a job inside a thread are kind `job` with their `parent`: they never sit under Direct messages, show under their parent agent (its Swarm and the Agents page's Jobs tab), and open by link.
2. `around=<item id or e<entry>>` returns the page that holds that entry and `focus`, the id of the item that holds it, so a search hit opens at its message.
3. A thread page always starts at an input, so a turn never splits across two pages.
4. In a thread, `message` items are inputs, `turn` items hold the answer text, the steps (thinking and tool calls with name, one-line summary, status and output) and the jobs the turn spawned, and `system` items are notes such as a compaction.
   An agent speaks to people only through its speaking tools, Prime's `tell_owner` (which pi-host's durable chat threads run from Prime's own chat extension) and pi-host's `send_message`, drawn alike (`SPEAKING_TOOLS` in `server/timeline.ts`). A turn of an agent that does holds `sent`, each call's text in order, which the page draws as one bubble each, and `text` is them joined by a blank line. Its other text becomes `note` steps beside its thinking and tool steps in the fold, and the calls themselves are not steps. A `tell_owner` call its guard held (its result opens with `Kept as a note, not sent`) is a `note` step, as Prime's feed shows it, and a refused one (an error result) is neither. A turn with `sent: []` sent nothing and draws only its fold, as "Worked quietly · N steps".
   A turn from before the conversation's first `send_message` call has no `sent`, and its own text is its bubble, so an agent that has never called the tool reads as before (`speaksThroughSendMessage` in `server/timeline.ts`). The server keeps the earliest call it has seen per conversation, so a page of quiet turns after it still reads as sent-only.
5. A turn's `jobs` hold each child conversation a `subagent` call made, which the page draws as a thread pill under the turn; a step's `job` names it too.
6. In a channel every post is a `message` item; a root post carries `thread` with its reply count, last reply and authors, and replies come from `replies`.
7. Send takes `text`, `images` (`{data, mimeType}`, base64 without the data: prefix), `mentions` (agent ids), `threadRoot` for a channel reply, `whenBusy` (steer, the default, or followUp) and a `requestId`, and a repeated `requestId` lands once.
8. A send lands in the chat server and answers at once, as in Slack; no answer waits on pi-host. A thread send is written to the outbox (`<data dir>/outbox.jsonl`), shows on every watching page as the owner's message `r:<requestId>` with `send: "sending"`, and goes to pi-host behind the answer as the owner's input, retried with backoff until pi-host takes it (`send: "sent"`, also a steer that waits for the running turn), and across a restart. The item goes away (`items` with `removed`) once the input with its text shows in the conversation. pi-host refusing it for good (no thread, archived) makes it `send: "failed"` with `sendError`, until Retry or Discard. Each mention in it goes to that agent as an agent message once pi-host has the send.
9. A channel send writes the post and answers; each mention goes to that agent's conversation as an `agent.message` input with a `[#channel · post N from You]` header and the thread so far (channels.md 4.1).
10. Every owner send and owner mention reaches pi-host with `ownerTurn: true`, so pi-pool starts its run at once; an agent's mention waits its place in the turn queue.
11. While a run waits for a working slot, the header and the `queue` events carry its place (`TurnPlace`: queued with position and total, or marked), the header has `queue`, and watchers get `queue` events until it works, when the place goes to null; a channel delivery carries the same place in `queue` and reads `queued` while it waits.
12. What the turn a mention starts sends with `send_message` comes back into the post's thread, one post per call, as that agent's posts, and the delivery reads `answered` with the first post; a call whose `to` names another channel is not posted there. A turn that sent nothing reads `no_reply`. A target that has never called `send_message` posts its answer's text as one post instead, or reads `no_reply` when it has none. A post 6 agent hops from the owner reads `stopped`.
13. A delivery's states are queued, delivered, read, answered, no_reply, stopped and failed.
14. Mentioning a non-member answers 400 with the line "X is not in #name. Add it to the channel first."

## Agents and models

| Call | Endpoint | Returns |
|---|---|---|
| `api.agents({archived})` | `GET /api/agents` | `AgentSummary[]`, one card per chat and job, newest first. |
| `api.createAgent({name, model, thinkingLevel, cwd, kind, parent})` | `POST /api/agents` | The new root thread's `AgentSummary`; `kind: "job"` with a `parent` files it under that chat. It runs in `cwd`, else in the default project folder; the home folder is refused with 400. |
| `api.projects()` | `GET /api/projects` | `ProjectList`: the configured project checkouts on this box (`APPS_CHAT_PROJECTS`, else `~/src/sieun-pi`, `~/Documents/Github/auto-sns-agent` and `~/Documents/Github/sieun-pi`), the first as `default`, and the `home` folder the server refuses. |
| `api.setAgentCwd(id, cwd)` | `PATCH /api/c/:id {cwd}` | The new header, with the root thread moved to `cwd`. |
| `api.agentConfig(id)` | `GET /api/agents/:id/config` | `AgentConfig`: identity and purpose, where it runs, its board, memory, instructions, swarm and 7-day usage. |
| `api.setAgentModel(id, "provider/id", level)` | `PATCH /api/c/:id` | The new header. |
| `api.stopAgent(id)` | `POST /api/c/:id/abort` | Stop. |
| `api.archiveAgent(id, archived)` | `PATCH /api/c/:id` | Archive or restore a root thread. |
| `api.models()` | `GET /api/models` | `ModelCatalog`: models with labels and thinking levels, and the default (Opus 5.5, high, c31). |

1. An agent's `status` is working, idle, sleeping or failed.
2. `parent` is the chat or job that started it, and `channels` lists the channels it is in.
3. `AgentConfig` reads each part where it lives (`server/agent-config.ts`): name, model, status and cwd from pi-host's thread row and tree; `purpose` from the conversation's first entry (the owner's first message, or the brief a parent or duty sent); the system text from `PRIME_BASE_PROMPT` in the running pi-host's `packages/pi-family/preamble.ts`; the thread file `<durable dir>/threads/<thread>.sqlite`; the board from its chat's `chat.board`; duties and the check-in from `<data dir>/boards/<chat>/duties.json`; usage from `durable_usage`.
4. A job's board, duties and check-in are its chat's: the root of its thread, or the chat a root job is filed under.
5. `memory` is `{kind: "none", note, related}` today: pi-host's durable registry gives a thread only the Prime preamble, coding tools and the subagent tool, so it has no memory store. `related` names the stores near it, such as Prime's continual harness (`<agent dir>/harness/harness_state.json`, which only Prime and pi-rlm kernels read) and its duties' precheck state files, each with `loaded: false`.
6. `instructions.files` are the AGENTS.md and CLAUDE.md files in its cwd and each folder above it, then `<agent dir>/AGENTS.md`, each `loaded: false`, since pi-durable loads none of them.
7. The web client opens a configuration at `#/agents/<id>` (with `?section=` overview, runs, board, memory, instructions or swarm) in the side panel; a card click or Enter opens it, Esc or back closes it, and Message opens the conversation.

## Channels

| Call | Endpoint | Returns |
|---|---|---|
| `api.channels()` | `GET /api/channels` | `Channel[]` with members and the last seq. |
| `api.createChannel({name, purpose, members, homeChat})` | `POST /api/channels` | The channel; the owner is always a member. |
| `api.updateChannel(id, {name, purpose, archived, homeChat})` | `PATCH /api/channels/:id` | The channel. |
| `api.addMembers(id, agents, wakeOn)` | `POST /api/channels/:id/members` | The channel; `wakeOn` is mention (default), all or none. |
| `api.removeMember(id, agent)` | `DELETE /api/channels/:id/members/:agent` | The channel. |

1. A channel's `homeChat` names the chat whose board its side panel shows.
2. A channel row's `unread` counts posts that mention the owner since his read mark, and `hasNew` says any post came since, so a busy room shows bold, not a number.

## Search

`api.search({q, from, in, after, before, sort, type, limit, cursor})` is `GET /api/search` and returns `SearchResult`: `{hits, total, nextCursor}`.

1. It covers every thread entry through pi-host's FTS5 index and every channel post. The server reads pi-host's `index.sqlite` (`--durable-index`, default `~/.prime/agent/pi-host/durable/index.sqlite`) on its own read-only connection with pi-host's `searchIndex`, so search answers while pi-host starts or is busy; `durable_search` over the socket answers only when that file is missing.
2. `q` may carry `from:`, `in:`, `after:` and `before:` tokens, and the separate params win over them.
3. `from` is a principal id (`owner` or an agent id) or `agents` (anyone but the owner), `in` a conversation id, and `after` and `before` are YYYY-MM-DD in KST, with `before` excluding that day.
4. `sort` is relevance (default) or recent, `type` is `messages` (no tool output) or `tools` (tool output only), and `limit` is 1 to 100 (default 20).
5. `total` is the exact count for the same filters (c191): pi-host counts every thread match and sends snippets for the page's rows only, and the server adds every matching post. Each message counts and shows once: copies of one entry in several threads show from the unarchived one, and the copy of a channel post sent into a mentioned agent's thread is left out, since the post itself is found in its channel.
6. A thread hit's `messageId` is its entry, `e<n>`, and a post's is `p<n>`, so `#/c/<conversation>?m=<messageId>` opens `items?around=<messageId>`, whose `focus` names the item that holds it. Search reads no thread file, so the first search after a start answers in under a second.
7. A snippet is escaped text whose only tags are `<mark>` around the matches, about 36 words of the message's human text (`server/search-snippet.ts`): an answer's own words before its tool calls, a `send_message` call's text as the agent's message rather than tool input, a tool's output with its JSON escapes and punctuation gone, and no routing or `[agent-message from X]` header. `text` holds up to 2,000 characters in the same form for "Show more", only when the message is longer.
8. Each hit says what it is. `role` is owner, agent, tool or system; a tool hit names its `tool`, and `inCall` says the match sits in a tool call's arguments rather than its output. `author.kind` is owner, agent or system (a check-in, job report or board note, with its label as the name), and an `[agent-message from X]` note names X. `conversation` carries `parent` (the agent a job or job DM belongs to) and `archived`, and a channel reply carries `threadRoot`.
9. By relevance, tool output (pi-host's `demoteKinds`) ranks after every message, and a hit whose match sits only in a tool call sinks below the messages of its page. pi-host's `durable_search` also takes `notFrom`, `kinds` and `skipKinds`, and in process `withText`.
10. The web client shows hits in the Cmd K rows (author, AGENT badge, place, kind and age) and on the full results page `#/search?q=&from=&in=&after=&before=&sort=&type=`, which Enter on the query opens. Each card reads the messages before and after it from `items?around=` (or `replies` for a thread reply) when it is expanded or keyboard-focused.

## Boards, For you, duties and check-ins

| Call | Endpoint | Returns |
|---|---|---|
| `api.board(chat)` | `GET /api/threads/:id/board` | `BoardView`: `{board, awaitingGo}`, with the ids of plan steps that wait for the owner's go. |
| `api.boardOps(chat, ops)` | `POST /api/threads/:id/board` | The new `BoardView` and `summaries`, one line per applied op; the ops are today's `BoardOp`s, applied as the owner. |
| `api.chatAgents(chat)` | `GET /api/threads/:id/agents` | `{agents: ChatAgent[]}` for the step owner chips. |
| `api.duties(chat)` | `GET /api/threads/:id/duties` | `{duties: DutyRow[]}`: today's `DutyView` with its newest 20 runs newest first and `running` while a run measures, plus `card` (`dutyCard`) and `last` (`judgedRun`, `missStreak`). |
| `api.dutyAction(chat, {duty, action, schedule})` | `POST /api/threads/:id/duties` | The duties after run, pause, resume or schedule. |
| `api.checkIn(chat)` | `GET /api/threads/:id/check-in` | `CheckInView`. |
| `api.setCheckIn(chat, {everyMs, pause})` | `POST /api/threads/:id/check-in` | The new `CheckInView`; pause is 1h, tomorrow, forever or null. |
| `api.importPrime(chat, primeId)` | `POST /api/threads/:id/import-prime {prime, cwd?}` | `{board, duties, runs, checkInMs}`: copies a moved Prime chat's board, duties, their last 20 runs each, each duty's precheck state and its check-in interval from Prime's chat data dir into the thread. With `cwd`, it first moves the thread to that project folder. |
| `api.forYou()` | `GET /api/for-you` | `{items: ForYouItem[]}` across every chat, open and done, newest first. |
| `api.boards()` | `GET /api/boards` | `BoardRow[]`: per chat its progress, open asks, steps awaiting a go, check-in and duties. |

1. A chat's board is the `chat.board` document of its root conversation in pi-host, changed through today's reducer (`lib/api/shared/chat-board.ts`).
2. Each owner op also reaches the chat as a `[board] ...` input, as today.
3. A duty run works as in today's chat: the server runs the duty's precheck command with STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE, judges its metrics, and records the run; when something is due (a miss, an error, an overrun or flagged items) it starts a duty job, a thread filed under the chat, whose `send_message` texts reach the chat as one `[duty <id>]` input from that job (a job that never called it sends its final answer, and "nothing to report" sends nothing).
4. A duty job, or any agent, changes a board with `POST /api/threads/:id/board {actor: "agent", ops}`; only the owner answers a todo, and a refused op answers 400.
5. A due check-in or wake reaches the chat as an input from `board`. `POST /api/threads/:id/wakes {id?, conversation?, on, note, since}` arms a wake, where `on` is the board skill's run, time or check wait; it answers `{wake, path, passes?}`, and `passes` means the check already exits 0. A wake is a JSON file in `<data dir>/wakes/` in the legacy chat's format, ticked by its own code (`server/wakes.ts`).

## Usage, pool and hosts

| Call | Endpoint | Returns |
|---|---|---|
| `api.usage({days, thread, host})` | `GET /api/usage` | `UsageReport`: rows per thread and model with tokens and the cost of each kind, one row per local day by model, and the period before. |
| `api.pool()` | `GET /api/pool` | `AccountsView` from the installed pi-pool CLI. |
| `api.hosts()` | `GET /api/hosts` | `HostsReport`: each box's relay, pi-host, machine reading and threads. |
| `api.corrections()` | `GET /api/corrections` | The owner's corrections ledger, read only. |

1. Usage totals and each kind's cost (input, output, cache read, cache write) are pi-host's own sums from each answer's usage (`durable_usage`), with no estimate.

## Live stores

| Store | What it holds |
|---|---|
| `me.value` | `Me`: the owner, the box, fixture mode, the wiki base URL. |
| `sidebar.value` | `Sidebar`, replaced on each `sidebar` event. |
| `agents.list`, `agents.byId(id)` | `AgentSummary[]`, upserted on each `agent` event and on `status`. |
| `conversations.list`, `conversations.byId(id)` | `ConversationSummary[]`, upserted on each `conversation` event. |
| `forYou.items`, `forYou.count` | Every todo, refetched on each board change, and the open count. |
| `connection.connected` | Whether the live socket is open. |
| `timeline(id, {around})` | `Timeline`: `items`, `older`, `loadOlder()`, `header`, `status`, `queue`, `focus`, `send(text, {images, mentions, threadRoot})`, `retrySend(itemId)`, `discardSend(itemId)`, `stop()`, `markRead()`, `close()`. |
| `replies(channel, root)` | `Replies`: `root`, `items`, `send(text, opts)`, `retrySend(itemId)`, `discardSend(itemId)`, `close()`. |
| `jobsStore(thread)` | `JobsStore`: `jobs`, live. |
| `boardStore(chat)` | `BoardStore`: `view` (`BoardView`), `apply(ops)`, `refresh()`, `close()`. |

1. A page makes a per-view store when it opens and calls `close()` when it leaves, so the server stops watching that conversation.
2. `send` shows the message at once as `r:<requestId>` and returns; the composer takes the next message right away. The post runs behind and tries 3 more times with the same requestId while the chat server cannot be reached; then the message stays on screen as failed with Retry and Discard. A pending item never steps back from sent to sending, and the real message replaces it when it lands.
3. Nothing streams: no partial text, thinking or tool calls. A running turn shows as an empty live turn (typing dots) from its run's start, and its item updates when an input, an answer with text or a `send_message` call lands, so a message shows the moment the agent sends it, and when the run ends. The live turn of an agent that talks through `send_message` draws its fold row with a spinner instead of typing dots.

## Live socket

`/api/live` is one WebSocket per tab, and `lib/api/live.svelte.ts` owns it.

1. The server sends `hello` (me, sidebar, agents, conversations) on connect, then `sidebar`, `agent`, `agent_removed`, `conversation`, `status`, `jobs`, `board`, `for_you`, `duties` and `channel` to every tab. `duties` carries a chat's `DutyRow[]` when a run starts or ends and when a duty is paused, resumed or rescheduled.
2. `items` and `queue` go only to tabs that watch that conversation; `items` may carry `removed`, ids to drop, such as a pending send that landed or was discarded. The server sends no `partial`.
3. A tab sends `{type: "watch", conversation, after}` and `{type: "unwatch", conversation}`, and `after` is the newest item id it holds, so a reconnect gets what it missed, and the thread's pending sends.

## Fixture mode

`npm run fixture` seeds these, all over the last five days.

1. Four chats are seeded: Vent (finished turns with thinking and tool steps, an image, a mermaid answer and a finished job), AI harness developer environment VP (a turn that runs for as long as the server runs, a running job and a board with every step state), Crawler VP (a rich answer with callouts, a table, a diagram, a task list, GitHub cards, file, wiki, thread and board pills, a screenshot, a fold and code, then a failed turn) and frontend bro.
2. pi cutover prep and Relay uptime duty <stamp> (the thread of duty d1's missed run) are root jobs of the AI harness VP, not DMs; Crawler VP is a chat opened as a DM; and old relay probe is archived.
3. Each chat runs in `<data dir>/work/<name>`, with AGENTS.md files there and in `work/`, and `<data dir>/prime-agent` stands in for Prime's agent dir with a global AGENTS.md and a harness store of two memories.
4. #pi-cutover has posts in answered, no_reply and queued states, a thread with two replies and an @owner post, and #general has one thread.
5. The AI harness VP has two duties with runs and a check-in.
6. A send to any thread gets an answer through `send_message`, the plain answer as two calls and every other as one, and the seeded turns and AI harness developer environment VP keep their plain-text answers, as agents from before the tool; a message with "quiet" writes a private note and sends nothing, "spawn" starts a job, "fail" ends in an error, "slow" takes a minute for Stop, "queue" waits 2 s at place 3 then 1 of 7 before it starts, "mermaid" answers with a diagram, "broken diagram" with a mermaid block that does not parse, and "rich" with an answer in every format the chat renders.
7. The words canary, relay and migration repeat across days and authors for search.

## Host seam

Every pi-host call goes through `server/host/` (`Host` in `types.ts`), which `pi-host.ts` implements over pi-host's `durable_*` socket commands and `fixture.ts` in memory.
While pi-host restarts, a call waits up to 30 s for it and then sends again, except `durable_create`, `durable_import` and a submit without a requestId, and live watches resume from the newest entry they delivered.
The default model and every model the pickers offer come from `config/allowed-models.ts` (c185).

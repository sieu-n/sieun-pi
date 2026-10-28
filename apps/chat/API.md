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
| `api.patch(id, {name, archived, model, thinkingLevel})` | `PATCH /api/c/:id` | The new header. A job inside a thread takes model changes only. |
| `api.read(id, seq?)` | `POST /api/c/:id/read` | Sets the owner's read mark. |
| `api.jobs(thread)` | `GET /api/threads/:id/jobs` | `JobNode[]`, the thread's job tree. |
| `api.openDm(agent)` | `POST /api/dms` | Lists that agent under DMs and returns its summary. |

1. A Solo row is a root thread of kind chat, and a DM row is a root job (a thread started for a chat) or any agent the owner opened with `openDm`.
2. `around=<item id or e<entry>>` returns the page that holds that entry and `focus`, the id of the item that holds it, so a search hit opens at its message.
3. A thread page always starts at an input, so a turn never splits across two pages.
4. In a thread, `message` items are inputs, `turn` items hold the answer text, the steps (thinking and tool calls with name, one-line summary, status and output) and the jobs the turn spawned, and `system` items are notes such as a compaction.
5. A turn's `jobs` hold each child conversation a `subagent` call made, which the page draws as a thread pill under the turn; a step's `job` names it too.
6. In a channel every post is a `message` item; a root post carries `thread` with its reply count, last reply and authors, and replies come from `replies`.
7. Send takes `text`, `images` (`{data, mimeType}`, base64 without the data: prefix), `mentions` (agent ids), `threadRoot` for a channel reply, `whenBusy` (steer, the default, or followUp) and a `requestId`, and a repeated `requestId` lands once.
8. A send lands in the chat server and answers at once, as in Slack; no answer waits on pi-host. A thread send is written to the outbox (`<data dir>/outbox.jsonl`), shows on every watching page as the owner's message `r:<requestId>` with `send: "sending"`, and goes to pi-host behind the answer as the owner's input, retried with backoff until pi-host takes it (`send: "sent"`, also a steer that waits for the running turn), and across a restart. The item goes away (`items` with `removed`) once the input with its text shows in the conversation. pi-host refusing it for good (no thread, archived) makes it `send: "failed"` with `sendError`, until Retry or Discard. Each mention in it goes to that agent as an agent message once pi-host has the send.
9. A channel send writes the post and answers; each mention goes to that agent's conversation as an `agent.message` input with a `[#channel · post N from You]` header and the thread so far (channels.md 4.1).
10. Every owner send and owner mention reaches pi-host with `ownerTurn: true`, so pi-pool starts its run at once; an agent's mention waits its place in the turn queue.
11. While a run waits for a working slot, the header and the `queue` events carry its place (`TurnPlace`: queued with position and total, or marked), the header has `queue`, and watchers get `queue` events until it works, when the place goes to null; a channel delivery carries the same place in `queue` and reads `queued` while it waits.
12. The answer of the turn a mention starts comes back into the post's thread as that agent's post, and the delivery reads `answered`; a turn with no text reads `no_reply`; a post 6 agent hops from the owner reads `stopped`.
13. A delivery's states are queued, delivered, read, answered, no_reply, stopped and failed.
14. Mentioning a non-member answers 400 with the line "X is not in #name. Add it to the channel first."

## Agents and models

| Call | Endpoint | Returns |
|---|---|---|
| `api.agents({archived})` | `GET /api/agents` | `AgentSummary[]`, one card per chat and job, newest first. |
| `api.createAgent({name, model, thinkingLevel, cwd, kind, parent})` | `POST /api/agents` | The new root thread's `AgentSummary`; `kind: "job"` with a `parent` files it under that chat. |
| `api.setAgentModel(id, "provider/id", level)` | `PATCH /api/c/:id` | The new header. |
| `api.stopAgent(id)` | `POST /api/c/:id/abort` | Stop. |
| `api.archiveAgent(id, archived)` | `PATCH /api/c/:id` | Archive or restore a root thread. |
| `api.models()` | `GET /api/models` | `ModelCatalog`: models with labels and thinking levels, and the default (Opus 5.5, high, c31). |

1. An agent's `status` is working, idle, sleeping or failed.
2. `parent` is the chat or job that started it, and `channels` lists the channels it is in.

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

`api.search({q, from, in, after, before, sort, limit, cursor})` is `GET /api/search` and returns `SearchResult`: `{hits, total, nextCursor}`.

1. It covers every thread entry through pi-host's FTS5 index and every channel post. The server reads pi-host's `index.sqlite` (`--durable-index`, default `~/.prime/agent/pi-host/durable/index.sqlite`) on its own read-only connection with pi-host's `searchIndex`, so search answers while pi-host starts or is busy; `durable_search` over the socket answers only when that file is missing.
2. `q` may carry `from:`, `in:`, `after:` and `before:` tokens, and the separate params win over them.
3. `from` is a principal id (`owner` or an agent id), `in` a conversation id, and `after` and `before` are YYYY-MM-DD in KST, with `before` excluding that day.
4. `sort` is relevance (default) or recent, and `limit` is 1 to 100 (default 20).
5. `total` is the exact count for the same filters (c191): pi-host counts every thread match and sends snippets for the page's rows only, and the server adds every matching post. Each message counts and shows once: copies of one entry in several threads show from the unarchived one, and the copy of a channel post sent into a mentioned agent's thread is left out, since the post itself is found in its channel.
6. A thread hit's `messageId` is its entry, `e<n>`, and a post's is `p<n>`, so `#/c/<conversation>?m=<messageId>` opens `items?around=<messageId>`, whose `focus` names the item that holds it. Search reads no thread file, so the first search after a start answers in under a second.
7. A snippet is escaped text whose only tags are `<mark>` around the matches.

## Boards, For you, duties and check-ins

| Call | Endpoint | Returns |
|---|---|---|
| `api.board(chat)` | `GET /api/threads/:id/board` | `BoardView`: `{board, awaitingGo}`, with the ids of plan steps that wait for the owner's go. |
| `api.boardOps(chat, ops)` | `POST /api/threads/:id/board` | The new `BoardView`; the ops are today's `BoardOp`s, applied as the owner. |
| `api.chatAgents(chat)` | `GET /api/threads/:id/agents` | `{agents: ChatAgent[]}` for the step owner chips. |
| `api.duties(chat)` | `GET /api/threads/:id/duties` | `{duties: DutyRow[]}`: today's `DutyView` plus `card` (`dutyCard`) and `last` (`judgedRun`, `missStreak`). |
| `api.dutyAction(chat, {duty, action, schedule})` | `POST /api/threads/:id/duties` | The duties after run, pause, resume or schedule. |
| `api.checkIn(chat)` | `GET /api/threads/:id/check-in` | `CheckInView`. |
| `api.setCheckIn(chat, {everyMs, pause})` | `POST /api/threads/:id/check-in` | The new `CheckInView`; pause is 1h, tomorrow, forever or null. |
| `api.importPrime(chat, primeId)` | `POST /api/threads/:id/import-prime {prime}` | `{board, duties, runs, checkInMs}`: copies a moved Prime chat's board, duties, their last 20 runs each, each duty's precheck state and its check-in interval from Prime's chat data dir into the thread. |
| `api.forYou()` | `GET /api/for-you` | `{items: ForYouItem[]}` across every chat, open and done, newest first. |
| `api.boards()` | `GET /api/boards` | `BoardRow[]`: per chat its progress, open asks, steps awaiting a go, check-in and duties. |

1. A chat's board is the `chat.board` document of its root conversation in pi-host, changed through today's reducer (`lib/api/shared/chat-board.ts`).
2. Each owner op also reaches the chat as a `[board] ...` input, as today.
3. A duty run works as in today's chat: the server runs the duty's precheck command with STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE, judges its metrics, and records the run; when something is due (a miss, an error, an overrun or flagged items) it starts a duty job, a thread filed under the chat, whose final answer reaches the chat as a `[duty <id>]` input from that job.
4. A duty job, or any agent, changes a board with `POST /api/threads/:id/board {actor: "agent", ops}`; only the owner answers a todo, and a refused op answers 400.
5. A due check-in or wake reaches the chat as an input from `board`; a wake is a JSON file `{id, thread, conversation?, at, text}` in `<data dir>/wakes/`.

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
3. Nothing streams: no partial text, thinking or tool calls. A running turn shows as an empty live turn (typing dots) from its run's start, and its item updates when an input or an answer with text lands, and when the run ends.

## Live socket

`/api/live` is one WebSocket per tab, and `lib/api/live.svelte.ts` owns it.

1. The server sends `hello` (me, sidebar, agents, conversations) on connect, then `sidebar`, `agent`, `agent_removed`, `conversation`, `status`, `jobs`, `board`, `for_you` and `channel` to every tab.
2. `items` and `queue` go only to tabs that watch that conversation; `items` may carry `removed`, ids to drop, such as a pending send that landed or was discarded. The server sends no `partial`.
3. A tab sends `{type: "watch", conversation, after}` and `{type: "unwatch", conversation}`, and `after` is the newest item id it holds, so a reconnect gets what it missed, and the thread's pending sends.

## Fixture mode

`npm run fixture` seeds these, all over the last five days.

1. Four chats are seeded: Vent (finished turns with thinking and tool steps, an image, a mermaid answer and a finished job), AI harness developer environment VP (a turn that runs for as long as the server runs, a running job and a board with every step state), Crawler VP (failed) and frontend bro.
2. pi cutover prep is a root job of the AI harness VP, listed as a DM, and old relay probe is archived.
3. #pi-cutover has posts in answered, no_reply and queued states, a thread with two replies and an @owner post, and #general has one thread.
4. The AI harness VP has two duties with runs and a check-in.
5. A send to any thread gets an answer; a message with "spawn" starts a job, "fail" ends in an error, "slow" takes a minute for Stop, "queue" waits 2 s at place 3 then 1 of 7 before it starts, and "mermaid" answers with a diagram.
6. The words canary, relay and migration repeat across days and authors for search.

## Host seam

Every pi-host call goes through `server/host/` (`Host` in `types.ts`), which `pi-host.ts` implements over pi-host's `durable_*` socket commands and `fixture.ts` in memory.
While pi-host restarts, a call waits up to 30 s for it and then sends again, except `durable_create`, `durable_import` and a submit without a requestId, and live watches resume from the newest entry they delivered.
The default model and every model the pickers offer come from `config/allowed-models.ts` (c185).

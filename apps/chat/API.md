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
| Agent | `ag_<slug>` | `ag_vent` |
| Agent's DM room | `dm_<slug>` | `dm_vent` |
| Work thread, root job thread, or a root chat no agent holds yet | pi-host thread id | `0f1e0000-0000-4000-8000-000000000001` |
| Job inside a thread | `<thread>:<conversation>` | `0f1e...0001:14` |
| Channel | `ch_<8 hex>` (the fixture's are `ch_cutover` and `ch_general`) | `ch_1a2b3c4d` |
| Solo room | `so_<8 hex>` | `so_0f1e0001` |
| Thread item | `e<entry>` for an input, `t<entry of its input>` for a turn | `e12`, `t12` |
| Room post (DM, channel or Solo room) | `p<seq>` | `p7` |

1. An agent (`agents.json`, `server/agents.ts`) has one main work thread, its root job threads, and one DM room. `/api/c/dm_<slug>` opens the DM, and `/api/c/<work thread id>` opens the work thread's transcript. A thread id of an agent's work thread or root job resolves to the agent wherever an agent id is taken, and a principal names the agent (`ag_<slug>`). A thread is an agent only through its record, which `POST /api/agents` or the migrate CLI (`scripts/migrate-agents.ts`) writes; the server never registers a root chat on its own, and the CLI skips an untitled one ("New thread", "Untitled" or no name).
2. An agent split into work and comm (agent-model.md phase 4) also has one comm thread per room, in its record's `comm`: its DM's, and one for each channel and Solo room whose post reached it (phase 5). The comm thread takes the room's posts and speaks in the room, and the work thread does the work. A comm thread id resolves to its agent for the board, check-in, folder and config routes, opens as a transcript by its id, and is never listed as an agent, a job or a solo chat.
3. The owner's principal id is `owner`.
4. A turn's id is the id of the input it answers, so the live turn keeps one id from the moment the input lands.
5. A pending send is `r:<requestId>` until its real item arrives: an input with its text in a thread, or the post with its `requestId` in a channel.

## Conversations and the sidebar

| Call | Endpoint | Returns |
|---|---|---|
| `api.sidebar()` | `GET /api/sidebar` | `Sidebar`: `solo`, `channels`, `dms` and the open For you count. |
| `api.conversations({archived})` | `GET /api/conversations?archived=1` | `ConversationSummary[]` for every solo thread, DM, job, channel and Solo room. |
| `api.directory()` | `GET /api/directory` | `{agents, jobs, rooms}` for the @ and # typeahead: `agents` as `GET /api/agents`, `jobs` as `GET /api/jobs`, `rooms` as `GET /api/rooms`. |
| `api.header(id)` | `GET /api/c/:id` | `ConversationHeader`: summary, members, model and the agent; a channel's purpose and home chat; a Solo room's agenda and `closedAt`; and for both, `boards`, the member agents whose boards the side panel shows. |
| `api.items(id, {before, after, around, limit})` | `GET /api/c/:id/items` | `TimelinePage`: items oldest first, with `older`, `newer` and `focus` cursors; a thread's newest page ends with its pending sends. |
| `api.replies(channel, root)` | `GET /api/c/:id/replies/:root` | A channel thread: `{root, items}`. |
| `api.send(id, SendRequest)` | `POST /api/c/:id/send` | `SendResult` at once: a DM's stored post, a thread's pending item `r:<requestId>`, or a channel's or Solo room's post with its deliveries. |
| `api.retrySend(id, requestId)` | `POST /api/c/:id/send/:requestId/retry` | `SendResult`: a failed room post or thread send tries again now; its failed deliveries go back to `queued`. |
| `api.discardSend(id, requestId)` | `DELETE /api/c/:id/send/:requestId` | Drops a failed thread send; its item goes away on every page. A room post is stored, so a room answers 400. |
| none (jobs and scripts call it) | `PATCH /api/c/:id/posts/:post` with `{testSend: {by, reason}}` | `SendResult`: marks a DM post that a job typed into the owner's composer as job `by`'s test send. The post, the work thread's input it wrote and its search hits then read as `by`'s, `from:owner` leaves them out, and pi-history reads the chat's `test-sends.json` to do the same. A post still on its way goes to the agent as `by`'s agent message; for one already delivered, the agent gets one agent message from `by` that says it was a test send. The server answers 400 for a missing `by` or `reason`, any other field, or a post the owner did not type in the room. |
| `api.abort(id)` | `POST /api/c/:id/abort` | Stops the running turn of that conversation; for a DM, of the agent's work and comm threads; for a channel or Solo room, of each member's comm thread there. |
| `api.patch(id, {name, archived, model, thinkingLevel, cwd})` | `PATCH /api/c/:id` | The new header. On a DM, a rename or archive changes the agent and its work thread, and the rest changes the work thread. A job inside a thread takes model changes only. `cwd` moves a root thread to another project folder, and its next request runs there; the server answers 400 for the home folder, a folder above it, a relative path or a missing folder. |
| `api.read(id, seq?)` | `POST /api/c/:id/read` | Sets the owner's read mark. |
| `api.threadJobs(thread)` | `GET /api/threads/:id/jobs` | `JobNode[]`, the thread's job tree. |
| `api.openDm(agent)` | `POST /api/dms {agent}` | The agent's DM summary; `agent` is an agent id or one of its thread ids. Every agent has a DM. |
| | `GET /api/dms` | Every agent's DM summary, archived ones too. |
| `![alt](/abs/path.png)` in markdown | `GET /api/local-image?path=` | An image file on this box by its absolute or `~/` path: PNG, JPEG, GIF, WebP or SVG up to 25 MiB whose bytes match its type. |

1. A DM row is one per agent that is not archived, `dm_<slug>`, with `agent` its agent id, `status` working while any of its threads runs, `preview` the newest post, and `unread` the agent's posts after the owner's read mark. The sidebar's `solo` group lists the Solo rooms first, open ones newest first, then closed ones (with `closedAt`), each with its `agenda`, then the root chats no agent holds. Such a root chat is a Solo row too, such as an untitled "New thread"; it stays solo until `POST /api/agents` or the migrate CLI makes it an agent. On its first thread list read after a start, the server drops each untitled record whose work thread is still untitled, with its aliases, and archives its DM room, so that chat is a Solo row again. An agent's work thread, a root job (a thread started for an agent, such as a duty run's thread) and a job inside a thread are kind `job` with their `parent` (a work thread's is its DM room): they never sit in the sidebar, show under their agent (its Swarm and the Agents page's Jobs tab), and open by link.
2. A DM is a room of posts the chat server stores in `<data dir>/rooms/dm_<slug>.jsonl` (`server/rooms.ts`), never a view of the thread. Its header has `workThread`, which "Open work thread" opens, and `readSeq`. Its items are `message` items, `p<seq>`, oldest first, and `before`, `after` and `around` take post ids. An owner post carries `requestId`, `send` and its delivery to the agent in `deliveries` (queued, delivered or failed). An agent post carries `why` (the tell_owner call's), `work` (the work thread and `e<entry>` of the call, for "Show work") and `jobs` (the jobs its turn started, with live status).
3. For a split agent, the first delivery makes the comm thread ("<name> · DM", Opus 5.5 at high thinking, in the agent's home), and every owner post and test send goes to it with `ownerTurn`. The feed reads the work thread to its end once and then reads only the comm thread, so a post's `work` names the comm turn. The DM row's `status` is working while the comm thread, the work thread or a job runs, and `commStatus` is the comm thread's own state. `AgentSummary.status` counts the work thread and its jobs only, and `AgentSummary.comm` lists each comm thread with its status.
4. A DM send writes the post and answers with it at once, shows it on every watching page, then delivers it to the agent's work thread as the owner's input (`requestId` `d:<post>:<agent>`, steer when busy, owner turn), retried with backoff and across a restart until pi-host takes it, or `failed` when pi-host refuses it for good. The agent answers through its speaking calls: each `tell_owner` or `send_message` with no `to` whose result says it went out becomes the agent's post, and a held or refused call posts nothing. A turn an old channel mention started in the work thread, from before phase 5, spoke to the channel, not the DM. An owner input typed in the work thread itself shows as his post once. A repeated `requestId`, or a re-read of the thread, lands nothing twice.
5. `around=<item id or e<entry>>` returns the page that holds that entry and `focus`, the id of the item that holds it, so a search hit opens at its message.
6. A thread page always starts at an input, so a turn never splits across two pages.
7. In a thread, `message` items are inputs, `turn` items hold the answer text, the steps (thinking and tool calls with name, one-line summary, status and output) and the jobs the turn spawned, and `system` items are notes such as a compaction.
   An agent speaks to people only through its speaking tools, Prime's `tell_owner` (which pi-host's durable chat threads run from Prime's own chat extension) and pi-host's `send_message`, drawn alike (`SPEAKING_TOOLS` in `server/timeline.ts`). A turn of an agent that does holds `sent`, each call's text in order, which the page draws as one bubble each, and `text` is them joined by a blank line. Its other text becomes `note` steps beside its thinking and tool steps in the fold, and the calls themselves are not steps. A `tell_owner` call its guard held (its result opens with `Kept as a note, not sent`) is a `note` step, as Prime's feed shows it, and a refused one (an error result) is neither. A turn with `sent: []` sent nothing and draws only its fold, as "Worked quietly · N steps".
   A turn from before the conversation's first `send_message` call has no `sent`, and its own text is its bubble, so an agent that has never called the tool reads as before (`speaksThroughSendMessage` in `server/timeline.ts`). The server keeps the earliest call it has seen per conversation, so a page of quiet turns after it still reads as sent-only.
7. A turn's `jobs` hold each child conversation a `subagent` call made, which the page draws as a thread pill under the turn; a step's `job` names it too.
8. In a channel or Solo room every post is a `message` item; a channel root post carries `thread` with its reply count, last reply and authors, and replies come from `replies`. A Solo room has no threads.
9. Send takes `text`, `images` (`{data, mimeType}`, base64 without the data: prefix), `mentions` (agent ids), `threadRoot` for a channel reply, `whenBusy` (steer, the default, or followUp) and a `requestId`, and a repeated `requestId` lands once.
10. A thread send lands in the chat server and answers at once, as in Slack; no answer waits on pi-host. A thread send is written to the outbox (`<data dir>/outbox.jsonl`), shows on every watching page as the owner's message `r:<requestId>` with `send: "sending"`, and goes to pi-host behind the answer as the owner's input, retried with backoff until pi-host takes it (`send: "sent"`, also a steer that waits for the running turn), and across a restart. The item goes away (`items` with `removed`) once the input with its text shows in the conversation. pi-host refusing it for good (no thread, archived) makes it `send: "failed"` with `sendError`, until Retry or Discard. Each mention in it, and each mention in a DM post other than of the DM's own agent, goes to the mentioned agent's work thread as an agent message once pi-host has the send. Only a registered agent is a target: an agent id, its DM room, its work thread or its name. A mention of a job, a thread no agent holds or a name only a job has is not delivered.
11. A channel or Solo room post wakes every member whose `wakeOn` is `all` (a Solo room's members), plus every member it mentions, minus its author; a channel thread reply wakes only the members it mentions, and a member with `wakeOn: none` wakes on nothing. Each woken member gets one delivery to its comm thread for that room, never its work thread: the first delivery makes the comm thread, named `<agent> · #<channel>` or `<agent> · Solo <name>` (with the room id after it when another thread has that name), on Opus 5.5 at high thinking. The request id is `d:<room>:<post>:<agent>`, retried with backoff and across a restart.
12. The input is one header line, a blank line and the post: `[#<channel> · post N from <author>[ (owner)] · hops H]`, or `[Solo "<name>" (so_x): <agenda, up to 300 characters> · with <members> · post N ...]`. A channel root post adds the root posts its member missed since the last root post it wrote or got, up to 5, under `(channel before this post)`, with their images, and a channel reply adds up to 5 earlier posts of its thread. An owner post goes in as the owner's turn (`ownerTurn`, steer when busy), and an agent post as an `agent.message` with `{from, via: <room>, post, hops}` that waits its turn (followUp).
13. Each comm thread's feed cursor sits in `rooms.json` under `commFeed`. Every `tell_owner` or `send_message` (with no `to`, or a `to` naming this room) whose result says it went out becomes the agent's post in the room, keyed `m:<thread>:<toolCallId>`, with `hops` one more than the post that started its turn (an owner post is hops 0), `mentions` from `@<member name>` and `@owner` in its text, and in a channel the thread of that post as `threadRoot`. The new post is delivered on like any other. A post 6 agent hops from the owner's last post gets `stopped` deliveries and is never submitted (`MAX_HOPS`, hard: money).
14. A closed Solo room, or an archived room, answers an owner post with 400 and a line that says to reopen or unarchive it, stores an agent post with no deliveries, and stops a delivery still on its way.
15. A delivery reads `queued` until pi-host takes it, then `delivered`, `answered` (with `answer`, the member's first post after it in the same thread) once the member posted, `stopped` or `failed`. While a run waits for a working slot, the header and the `queue` events carry its place (`TurnPlace`), and watchers get `queue` events until it works.
16. As in Slack, the owner's mention of a registered agent that is not a member adds it to the room with the `wakeOn` of a member add (`mention` in a channel, `all` in a Solo room) and delivers the post, so the @ typeahead offers every agent. A mention of a job or a thread no agent holds is dropped from the post.

## Agents and models

| Call | Endpoint | Returns |
|---|---|---|
| `api.agents({archived})` | `GET /api/agents` | `AgentSummary[]`, one card per registered agent (`ag_<slug>`, kind `chat`), newest first. A thread no agent holds is not in it. |
| `api.jobs({archived})` | `GET /api/jobs` | `AgentSummary[]`, kind `job`, newest first: each child conversation of an agent's work thread or root job thread, and each root job thread filed under an agent. `parent` is the agent or job that started it and `agent` the registered agent it works for, also under a job. A job of a thread no agent holds is in neither list. |
| `api.createAgent({name, model, thinkingLevel, cwd, kind, parent})` | `POST /api/agents` | The new agent's `AgentSummary` (`ag_<slug>`, with `room` and `home`): its work thread, record and DM room are made at once. `kind: "job"` with a `parent` makes a root job thread filed under that agent instead, and `kind: "solo"` makes a root chat no agent holds, as the composer's new chat does. `test: true` makes a walk's test agent: neither it, its DM, its jobs nor its comm threads show in an owner list, a live event, the For you badge or `GET /api/agents` without `?test=1`. It runs in `cwd`, else in the default project folder; the home folder is refused with 400. |
| `api.projects()` | `GET /api/projects` | `ProjectList`: the configured project checkouts on this box (`APPS_CHAT_PROJECTS`, else `~/src/sieun-pi`, `~/Documents/Github/auto-sns-agent` and `~/Documents/Github/sieun-pi`), the first as `default`, and the `home` folder the server refuses. |
| `api.setAgentCwd(id, cwd)` | `PATCH /api/c/:id {cwd}` | The new header, with the root thread moved to `cwd`. |
| `api.agentConfig(id)` | `GET /api/agents/:id/config` | `AgentConfig`: identity and purpose, where it runs, its board, folder, memory, instructions, swarm and 7-day usage. |
| `api.agentFolder(id)` | `GET /api/agents/:id/folder` | `AgentFolder`: the agent's folder `dir`, its `brief` with its `text`, and its `memory` store with every entry, the newest `updatedAt` first. |
| `api.setBrief(id, text)` | `PUT /api/agents/:id/brief {text}` | The `AgentFolder` after `brief.md` is written; empty or blank text deletes the file. |
| none | `POST /api/agents/:id/split` | Body `{apply?: boolean}`. Without `apply`, the `SplitPlan`: the comm thread the record holds or would create, its `agent.ref`, and the work thread's ref before and after, with no writes. With `apply: true`, `{plan, comm}` after `ensureComm` made or found the comm thread and moved the feed. A non-boolean `apply` is 400 and an unknown agent 404. `scripts/split-agents.ts` drives it. |
| `api.addMemory(id, {title, content, path})` | `POST /api/agents/:id/memory` | The `AgentFolder` with a new memory entry whose id is Prime's slug of the title and whose `source` is `owner`. A title whose id the store already holds is 409. |
| `api.updateMemory(id, entry, {title, content, path}, kind)` | `PUT /api/agents/:id/memory/:entry?kind=memory` | The `AgentFolder` after the entry takes the new title and content, keeps its path unless one is given, and goes up one `version`. A missing entry is 404. |
| `api.deleteMemory(id, entry, kind)` | `DELETE /api/agents/:id/memory/:entry?kind=memory` | The `AgentFolder` without the entry. A missing entry is 404. |
| `api.setAgentModel(id, "provider/id", level)` | `PATCH /api/c/:id` | The new header. |
| `api.stopAgent(id)` | `POST /api/c/:id/abort` | Stop. |
| `api.archiveAgent(id, archived)` | `PATCH /api/c/:id` | Archive or restore a root thread. |
| `api.models()` | `GET /api/models` | `ModelCatalog`: models with labels and thinking levels, and the default (Opus 5.5, high, c31). |

1. An agent's `status` is working, idle, sleeping or failed.
2. An agent's `thread` is its work thread, `room` its DM, and `home` the work thread's cwd when the agent was made. A job's `parent` is the agent or job that started it, and an agent's `rooms` lists the channels and Solo rooms it is a member of. Members and mentions of a room store agent ids. Adding a member takes a registered agent's id, DM room, work thread or name, and answers 400 for a job, a comm thread or a thread no agent holds.
3. `AgentConfig` reads each part where it lives (`server/agent-config.ts`): name, model, status and cwd from pi-host's thread row and tree; `purpose` from the conversation's first entry (the owner's first message, or the brief a parent or duty sent); the system text from `PRIME_BASE_PROMPT` in the running pi-host's `packages/pi-family/preamble.ts`; the thread file `<durable dir>/threads/<thread>.sqlite`; the board from its agent's work thread's `chat.board`; duties and the check-in from `<data dir>/agents/<agent id>/duties.json`; usage from `durable_usage`.
4. A job's board, duties and check-in are its agent's: the agent of its thread, or the agent a root job is filed under.
5. `folder` is the folder of the agent the card belongs to, which its work thread, the jobs inside it and the root jobs filed under it share, and `null` for a root chat no agent holds yet. `memory` is `{kind: "agent", note, related}` for such a card: every thread of the agent gets Prime's harness digest of Prime's global store merged with the agent's store, and its kernel's `rlm.harness` writes the agent's store. With no agent it is `{kind: "none", note, related}`, and the thread's own store under pi-host's `session-artifacts/<thread>/harness` takes the agent store's place. `related` lists Prime's global store (`<agent dir>/harness/harness_state.json`, `loaded: true`), the thread's own store when no agent holds it, and its duties' precheck state files (`loaded: false`).
6. `instructions.files` are the AGENTS.md and CLAUDE.md files in its cwd and each folder above it, then `<agent dir>/AGENTS.md`. pi-host loads them through Prime's resource loader, one per folder with AGENTS.md first, so each is `loaded: true` except a CLAUDE.md beside an AGENTS.md.
7. An agent's folder is `<agents dir>/<slug>/` (`server/agent-folder.ts`), where the agents dir is `APPS_CHAT_AGENTS_DIR`, else `~/.pi/agent/agents`, and `<data dir>/agent-folders` on the fixture. It holds `brief.md`, the agent's responsibility, which pi-host adds after the AGENTS.md files as one more Prime context file, and `harness/harness_state.json`, a Prime harness store. The server writes the store as Prime's `harness.py` does: it reads the file again for each write, writes JSON with indent 2 to a temp file beside it, renames it over the old one and gives a new file mode 0600. `:id` on the folder routes is any id of the agent, as on the board routes: its agent id, DM room, work thread, a job inside it, or a root job filed under it. A missing agent is 404 and a bad body or `kind` is 400.
8. Every work thread holds an `agent.ref` doc in its root conversation, `{agent, dir, role: "work"}`, and every root job thread filed under an agent holds one with `role: "job"`, through pi-host's `durable_doc_put`. pi-host reads it to find the brief and the store. The server writes the doc when it makes an agent or files a job, and after each thread list read and each migration it writes it for any listed thread whose doc is missing or different. A failed write is logged and tried on the next read, and it never holds up a send.
9. The web client opens a configuration at `#/agents/<id>` (with `?section=` overview, runs, board, memory, instructions or swarm) in the side panel; a card click or Enter opens it, Esc or back closes it, and Message opens the conversation.

## Channels and Solo rooms

| Call | Endpoint | Returns |
|---|---|---|
| `api.rooms()` | `GET /api/rooms` | `Room[]`: every channel and Solo room not archived and not a test room, with members (the owner first) and the last seq. `?test=1` adds the test rooms. |
| `api.createRoom(RoomInput)` | `POST /api/rooms` | The `Room`. A channel needs a name no open channel has; its `agenda` is its purpose and its members wake on a mention. A Solo room needs an agenda and at least one agent, its name defaults to the agenda's first line, its members wake on every post, and its agenda becomes the owner's first post, delivered to every member. `test: true` makes a walk's test room, which no owner list, live event or badge shows; it opens by id and delivers as any room. |
| `api.updateRoom(id, RoomPatch)` | `PATCH /api/rooms/:id` | The `Room`: `name`, `agenda` (a channel's purpose), `archived`, a channel's `homeChat`, and a Solo room's `closed`, which closes it (`closedAt`) or reopens it. A channel's new name is normalized as on create, and the server answers 400 for a blank name, a name another open channel holds, or an unarchive while an open channel holds the name. Links stay valid because they name the id. |
| `api.addMembers(id, agents, wakeOn)` | `POST /api/rooms/:id/members` | The `Room`; `wakeOn` is all, mention or none, and defaults to all in a Solo room and mention in a channel. |
| `api.removeMember(id, agent)` | `DELETE /api/rooms/:id/members/:agent` | The `Room`. |

1. Rooms live in `<data dir>/rooms.json` and each room's posts in `<data dir>/rooms/<id>.jsonl` (`server/group-rooms.ts`, through `server/agent-store.ts`). The server never reads the old `channels.json`; `server/migrate-channels.ts` moves it.
2. A channel's `homeChat` names the chat whose board its side panel shows, and a Solo room's side panel shows each member's board (`header.boards`).
3. A channel row's `unread` counts posts that mention the owner since his read mark, and a Solo row's counts every agent post since it; `hasNew` says any agent post came since. A room's `status` is working while a member's comm thread there answers.

## Search

`api.search({q, from, in, after, before, sort, type, limit, cursor})` is `GET /api/search` and returns `SearchResult`: `{hits, total, nextCursor}`.

1. It covers every thread entry through pi-host's FTS5 index and every channel and Solo room post. The server reads pi-host's `index.sqlite` (`--durable-index`, default `~/.prime/agent/pi-host/durable/index.sqlite`) on its own read-only connection with pi-host's `searchIndex`, so search answers while pi-host starts or is busy; `durable_search` over the socket answers only when that file is missing.
2. `q` may carry `from:`, `in:`, `after:` and `before:` tokens, and the separate params win over them.
3. `from` is a principal id (`owner` or an agent id) or `agents` (anyone but the owner), `in` a conversation id, and `after` and `before` are YYYY-MM-DD in KST, with `before` excluding that day.
4. `sort` is relevance (default) or recent, `type` is `messages` (no tool output) or `tools` (tool output only), and `limit` is 1 to 100 (default 20).
5. `total` is the exact count for the same filters (c191): pi-host counts every thread match and sends snippets for the page's rows only, and the server adds every matching post. Each message counts and shows once: copies of one entry in several threads show from the unarchived one, comm threads are left out, since every room post is found in its room, and so is the copy of a channel post the router before phase 5 sent into a work thread.
6. A thread hit's `messageId` is its entry, `e<n>`, and a post's is `p<n>`, so `#/c/<conversation>?m=<messageId>` opens `items?around=<messageId>`, whose `focus` names the item that holds it. Search reads no thread file, so the first search after a start answers in under a second.
7. A snippet is escaped text whose only tags are `<mark>` around the matches, about 36 words of the message's human text (`server/search-snippet.ts`): an answer's own words before its tool calls, a `send_message` call's text as the agent's message rather than tool input, a tool's output with its JSON escapes and punctuation gone, and no routing or `[agent-message from X]` header. `text` holds up to 2,000 characters in the same form for "Show more", only when the message is longer.
8. Each hit says what it is. `role` is owner, agent, tool or system; a tool hit names its `tool`, and `inCall` says the match sits in a tool call's arguments rather than its output. `author.kind` is owner, agent or system (a check-in, job report or board note, with its label as the name), and an `[agent-message from X]` note names X. `conversation` carries `parent` (the agent a job or job DM belongs to) and `archived`, and a channel reply carries `threadRoot`.
9. By relevance, tool output (pi-host's `demoteKinds`) ranks after every message, and a hit whose match sits only in a tool call sinks below the messages of its page. pi-host's `durable_search` also takes `notFrom`, `kinds` and `skipKinds`, and in process `withText`.
10. The web client shows hits in the Cmd K rows (author, AGENT badge, place, kind and age) and on the full results page `#/search?q=&from=&in=&after=&before=&sort=&type=`, which Enter on the query opens. Each card reads the messages before and after it from `items?around=` (or `replies` for a thread reply) when it is expanded or keyboard-focused.

## Boards, For you, duties and check-ins

| Call | Endpoint | Returns |
|---|---|---|
| `api.board(chat)` | `GET /api/agents/:id/board` | `BoardView`: `{board, awaitingGo}`, with the ids of plan steps that wait for the owner's go. |
| `api.boardOps(chat, ops)` | `POST /api/agents/:id/board` | The new `BoardView` and `summaries`, one line per applied op; the ops are today's `BoardOp`s, applied as the owner. |
| `api.chatAgents(chat)` | `GET /api/agents/:id/agents` | `{agents: ChatAgent[]}` for the step owner chips. |
| `api.duties(chat)` | `GET /api/agents/:id/duties` | `{duties: DutyRow[]}`: today's `DutyView` with its newest 20 runs newest first and `running` while a run measures, plus `card` (`dutyCard`) and `last` (`judgedRun`, `missStreak`). |
| `api.dutyAction(chat, {duty, action, schedule})` | `POST /api/agents/:id/duties` | The duties after run, pause, resume or schedule. |
| `api.checkIn(chat)` | `GET /api/agents/:id/check-in` | `CheckInView`. |
| `api.setCheckIn(chat, {everyMs, pause})` | `POST /api/agents/:id/check-in` | The new `CheckInView`; pause is 1h, tomorrow, forever or null. |
| `api.importPrime(chat, primeId)` | `POST /api/threads/:id/import-prime {prime, cwd?}` | `{board, duties, runs, checkInMs}`: copies a moved Prime chat's board, duties, their last 20 runs each, each duty's precheck state and its check-in interval from Prime's chat data dir into the thread. With `cwd`, it first moves the thread to that project folder. |
| `api.forYou()` | `GET /api/for-you` | `{items: ForYouItem[]}` across every chat, open and done, newest first. |
| `api.boards()` | `GET /api/boards` | `BoardRow[]`: per chat its progress, open asks, steps awaiting a go, check-in and duties. |

1. Boards, duties and check-ins are keyed by agent id. Each `/api/agents/:id/...` route has a `/api/threads/:id/...` twin that takes a thread id and resolves it to its agent, because pi-host's `chat_board` tool and the duty briefs name the thread; a root chat no agent holds yet keys by its thread id. `ForYouItem.chatId`, `BoardRow.chatId` and the `board` and `duties` events' `chatId` are agent ids, and `chatName` the agent's name.
2. An agent's board is the `chat.board` document of its work thread's root conversation in pi-host, changed through today's reducer (`lib/api/shared/chat-board.ts`). Its duties, their precheck state and its check-in live in `<data dir>/agents/<agent id>/`; an agent whose old `boards/<thread>/` folder the migration has not copied yet keeps using that folder.
3. Each owner op also reaches the work thread as a `[board] ...` input, as today.
4. A duty run works as in today's chat: the server runs the duty's precheck command with STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE, judges its metrics, and records the run; when something is due (a miss, an error, an overrun or flagged items) it starts a duty job, a thread filed under the chat, whose `send_message` texts reach the chat as one `[duty <id>]` input from that job (a job that never called it sends its final answer, and "nothing to report" sends nothing).
5. A duty job, or any agent, changes a board with `POST /api/threads/:id/board {actor: "agent", ops}`; only the owner answers a todo, and a refused op answers 400.
6. A due check-in or wake reaches the work thread as an input from `board`. `POST /api/threads/:id/wakes {id?, conversation?, on, note, since}` arms a wake, where `on` is the board skill's run, time or check wait; it answers `{wake, path, passes?}`, and `passes` means the check already exits 0. A wake is a JSON file in `<data dir>/wakes/` in the legacy chat's format, ticked by its own code (`server/wakes.ts`).

## Usage, pool and hosts

| Call | Endpoint | Returns |
|---|---|---|
| `api.usage({days, thread, host})` | `GET /api/usage` | `UsageReport`: rows per thread and model with tokens and the cost of each kind, one row per local day by model, and the period before. |
| `api.pool()` | `GET /api/pool` | `AccountsView` with no thread, from the pi-pool reading the Accounts endpoints share. |
| `api.hosts()` | `GET /api/hosts` | `HostsReport`: each box's relay, pi-host, machine reading and threads. |
| `api.corrections()` | `GET /api/corrections` | The owner's corrections ledger, read only. |

1. Usage totals and each kind's cost (input, output, cache read, cache write) are pi-host's own sums from each answer's usage (`durable_usage`), with no estimate.

## Accounts

`server/accounts.ts` runs every pi-pool call through the old chat's own code (`legacy/prime/user-history/src/chat-pool.ts`), and `web/src/pages/accounts/api.ts` calls it. A `thread` is any id from the Ids table: an agent or DM reads as the agent's work thread, and a conversation as its root thread. pi-pool knows a root thread as the tree `pi-durable:<root thread id>`.

| Call | Endpoint | Returns |
|---|---|---|
| `accountsApi.view({thread, model, fresh})` | `GET /api/accounts?thread=&model=&fresh=1` | `AccountsView` of the thread's tree, or of no thread; `sessionId` is the tree and `priority` its class. |
| `accountsApi.action(action)` | `POST /api/accounts` | An `AccountAction` (`use`, `follow`, `pin`, `unpin`, `switch`, `disable`, `enable`, `remove`, `resets`, `reset`, `recheck`); `use` and `follow` name the thread in `id`. It answers that thread's `AccountsView`, or the pool's with the action's `notice`. |
| `accountsApi.priority(thread, priority)` | `POST /api/accounts/priority` | `{thread, priority}` with high, normal or low; the thread's `AccountsView`. |
| `accountsApi.login()` | `GET /api/accounts/login` | The last `AccountLogin`, or null. |
| `accountsApi.startLogin(provider, account)` | `POST /api/accounts/login` | `{provider, account}`, where a null account adds one; the new `AccountLogin`. |
| `accountsApi.pasteLogin(id, code)` | `POST /api/accounts/login/paste` | `{id, code}`: the callback URL or code for a Claude sign-in. |
| `accountsApi.cancelLogin(id)` | `POST /api/accounts/login/cancel` | `{id}`: the login, which ends as cancelled. |
| `accountsApi.refreshes()` | `GET /api/accounts/refresh` | `UsageRefresh[]`, the last run per provider. |
| `accountsApi.startRefresh(provider, account)` | `POST /api/accounts/refresh` | `{provider, account}`, where a null account reads all; the new `UsageRefresh`. |

1. The page polls the login and the refresh once a second while one runs; the server pushes nothing for them.
2. A pi-pool failure answers 400 with the pool's message in `error`; a second login or refresh while one runs answers 409, and a paste to an ended login 404.
3. A tree that never sent a request has no pool record. Its view is the pool's with a sentence in each resolution's `error`, and `use`, `follow` and a class set on it answer 409, because pi-pool takes a new tree only as a session uuid.
4. Each POST writes one service log line with the action, the account, the thread and its tree, and the client's address and user agent.
5. pi-host has no command that runs a failed turn again, so a thread moved to another account takes it at its next request or its next pool poll.

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

1. The server sends `hello` (me, sidebar, agents, jobs, conversations) on connect, then `sidebar`, `agent` and `agent_removed` (registered agents only), `job` and `job_removed` (the `GET /api/jobs` list), `conversation`, `status`, `jobs`, `board`, `for_you`, `duties` and `room` (a channel or Solo room whose row or members changed) to every tab. `duties` carries a chat's `DutyRow[]` when a run starts or ends and when a duty is paused, resumed or rescheduled.
2. `items` and `queue` go only to tabs that watch that conversation, and a DM's `status` follows its agent, so the page draws typing dots while the agent works; `items` may carry `removed`, ids to drop, such as a pending send that landed or was discarded. The server sends no `partial`.
3. A tab sends `{type: "watch", conversation, after}` and `{type: "unwatch", conversation}`, and `after` is the newest item id it holds, so a reconnect gets what it missed, and the thread's pending sends.

## Fixture mode

`npm run fixture` seeds these, all over the last five days.

1. Four agents are seeded, each with its work thread and DM room: Vent (finished turns with thinking and tool steps, an image, a mermaid answer and a finished job), AI harness developer environment VP (a turn that runs for as long as the server runs, a running job and a board with every step state), Crawler VP (a rich answer with callouts, a table, a diagram, a task list, GitHub cards, file, wiki, thread and board pills, a screenshot, a fold and code, then a failed turn) and frontend bro.
2. pi cutover prep and Relay uptime duty <stamp> (the thread of duty d1's missed run) are root jobs of the AI harness VP, Vent's job has a job of its own (error timestamps), and old relay probe is an archived agent. "New thread" is a root chat no agent holds, with a job of its own (clock source check): it sits in the sidebar's Solo group, and neither it nor its job is in `/api/agents` or `/api/jobs`. Vent's DM has its history as posts, one with a `why` and a job pill, and an owner post whose answer came from a `tell_owner` call; the other DMs hold their first exchange.
3. Each chat runs in `<data dir>/work/<name>`, with AGENTS.md files there and in `work/`, and `<data dir>/prime-agent` stands in for Prime's agent dir with a global AGENTS.md and a harness store of two memories. Vent's folder in `<data dir>/agent-folders/vent` has a brief and one memory its threads wrote, and the other agents' folders start empty.
4. #pi-cutover (`ch_cutover`) has answered and delivered mentions, a thread with two replies, a post by the root job pi cutover prep and an @owner post, and #general (`ch_general`) has one thread. The Solo room "relay protocol" (`so_0f1e0001`) has Vent and frontend bro with three posts of sequence (d), two of them unread, and "wiki cleanup" (`so_0f1e0002`) is closed, with Vent and Crawler VP.
5. The AI harness VP has two duties with runs and a check-in, in `agents/ag_ai-harness-developer-environment-vp/`.
6. A DM post or a send to any thread gets an answer through `send_message`, which comes back to a DM as the agent's posts, the plain answer as two calls and every other as one (a channel or Solo room post always gets one, so two members answering each other add two posts a hop until the 6-hop cap), and the seeded turns and AI harness developer environment VP keep their plain-text answers, as agents from before the tool; a message with "quiet" writes a private note and sends nothing, "spawn" starts a job, "fail" ends in an error, "slow" takes a minute for Stop, "queue" waits 2 s at place 3 then 1 of 7 before it starts, "mermaid" answers with a diagram, "broken diagram" with a mermaid block that does not parse, and "rich" with an answer in every format the chat renders.
7. The words canary, relay and migration repeat across days and authors for search.
8. The pool is `server/fixture/fake-pi-pool.mjs`, with its state in `<data dir>/pi-pool/`: an account in each state, named by it (`claude-ready`, `claude-pinned`, `claude-off`, `claude-reauth`, `claude-terms`, `claude-refused`, `claude-cooldown`, `claude-limited`, `claude-depleted`, `claude-stale`, `claude-resets`, `claude-pending`, `codex-ready`, `codex-off`). The AI harness VP keeps a Manual pick at high class, Crawler VP waits for `claude-limited` at low class, and "New thread" has no pool record. A Claude sign-in takes any pasted line, and a Codex one shows the code ABCD-1234 and ends by itself. `GET /api/fixture/pi-pool` reads its state and `POST /api/fixture/pi-pool/reset` seeds it again.

## Host seam

Every pi-host call goes through `server/host/` (`Host` in `types.ts`), which `pi-host.ts` implements over pi-host's `durable_*` socket commands and `fixture.ts` in memory.
While pi-host restarts, a call waits up to 30 s for it and then sends again, except `durable_create`, `durable_import` and a submit without a requestId, and live watches resume from the newest entry they delivered.
The default model and every model the pickers offer come from `config/allowed-models.ts` (c185).

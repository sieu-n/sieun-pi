# Browser chat for Prime Agent

A thin browser front end for native Prime Agent sessions. `/what-did-i-say` and `/agent-chat` in the terminal start or reuse the shared server and print its URL. Nothing opens a browser for you. Run `/reload` in the terminal after updating the extension.

Prime Agent owns every run, queue, name, model, skill and worker. The browser attaches to the daemon the same way the terminal's agents view does. Closing or refreshing a tab never stops a worker.

## What you see

- Sidebar: two tabs, Threads and Heartbeats. A thread with an active or paused heartbeat or cron job (daemon `cron_list`) sits under Heartbeats. Each tab sorts Needs response first, then Working, then the rest by priority and recent activity. Needs response means the thread is not running, has messages, and had activity after you last opened it in the browser. Each row has two lines: the title with a status on the right (a spinner and how long it has worked, or a dot), then the creation date (or the heartbeat label and next run), tag chips and a priority glyph of 0 to 3 bars. Working time starts at the open thread's native run start, else when the server first saw the thread busy. Hover a row for its menu, or right click it: rename, priority, and tags (assign, create, rename, delete). With a row focused, Up and Down move, 0 to 3 set priority, T opens the menu and F2 renames. Archived threads sit behind a toggle. Drag the right edge (or focus it and use Left/Right, Home/End) to set a width from 180 to 480 px; the width is saved in the browser.
- Agents view: the list button at the top of the sidebar opens a table of every thread with search, filters (status, kind, tag, priority, workspace, model, created date range, archived), sortable columns and bulk tags and priority. Up and Down move, Enter opens, Space selects, 0 to 3 set priority, T edits tags.
- New chat: the default screen. A greeting and the composer. The bar under the input holds the workspace and account on the left and the model and effort on the right. The first send creates a resident native session, attaches, and streams the reply.
- Thread: the whole transcript, opened at the bottom. Only what the user typed is a bubble on the right; a skill invocation shows the typed text with a skill tag. Agent messages, heartbeats and background command completions show as one muted line that also holds the turn's work. The header is one 40 px row: the title (click or F2 to rename; its tooltip shows the session id), the Default and Questions toggle, and the agents button. Questions lists every prompt, and a click jumps back to that turn in Default. The bar under the input holds attach, the account with its email and a meter per usage window, and context on the left, and one model button ("GPT-6 Astra · high") and Send or Stop on the right. In Default each turn shows the prompt, or a one-line trigger, and only its final reply. Everything else in the turn (thinking, tool calls, interim messages, system notes, agent messages that arrived mid-run) folds into one collapsed row such as "Worked 6m 12s · 39 tool calls · 3 notes". While the turn runs, that row shows the current step with a spinner and stays collapsed until you open it. Replies render as markdown with copy buttons. Errors and stopped replies stay visible.
- Composer: Enter sends, Shift+Enter adds a line, "/" opens the native command and skill menu, images paste or drop in. Prime sends these images at full size, so the extension's `context` hook scales any image in the model context, including tool screenshots, to 2000 px on its longest edge before each model call. Anthropic rejects larger images once a request holds more than 20. The menu matches a skill with or without its `skill:` prefix and by description, and it works on the new-chat screen too. It lists the native session commands `/compact`, `/refine`, `/goal` and `/autonomous`; they run through the normal prompt path.
- Model button: Favorites on top (GPT-6 Astra, Claude Opus 5.5 and Claude Fable 5.1 by default; the star adds or removes one, saved in the browser), a search box, the other models by provider, and an Effort row with the model's native thinking levels. On a thread, native `setModel` and `setThinkingLevel` also set the default for new chats.
- Context: hover or focus the ring to see context tokens, session cost, input, output, cache read and cache write totals from native `getSessionStats`, and the last call's cache hit rate from its native `usage`. A dot flags a cache problem: red when a warm call (same model, under 5 minutes after the previous call, prompt of 10k tokens or more) reads under 50% from the cache; amber when it reads under 90%, or 10 points under the thread's median, when it writes more than 20% of its prompt to the cache, or when 2 of the last 20 warm calls missed. The thresholds come from 13,583 warm calls in 40 recent threads (median hit 99.5%, p5 93.9%). While the agent works, the button becomes Stop, Enter queues a follow-up and Cmd+Enter steers. Queued messages show as chips you can edit or remove.
- Saved threads open read-only in a few hundred milliseconds. Sending a reply resumes them natively.
- Account: the composer bar shows the thread's account by full email, with a small meter for each of its usage windows (Claude: 5h, week and the Fable weekly cap; Codex: the windows its plan has). Hover shows the reset times. A click opens Settings.
- Settings: a dialog opened from the account or the gear in the sidebar. Accounts is the first section. It has a tab per provider, the sentence "This thread uses X (reason)", and one row per account: email, plan, one state badge (seat, live, pinned, depleted, cooldown, refused, needs login) and every usage window with its percent and "resets in 3h 46m". Refused, logged-out and stale accounts carry a one-line note. Use and Follow the pool act on the thread at once. Pin for all sessions, Unpin, Drop seat and Check again (re-probe refused Claude accounts) ask first. Refresh usage asks tokenmaxxing to read every account's usage now.

Keyboard: Cmd+N new chat, Cmd+K search, Cmd+B sidebar, F2 rename, Esc closes menus or stops a busy thread when the composer has focus. Use `/compact` in the composer to compact context.

Light and dark follow the OS. Below 900 px the sidebar becomes an overlay.

## How it works

```text
browser  <- SSE api/sessions/stream ---- Catalog: one DaemonClient, roster_subscribe, list all
browser  <- SSE api/threads/:id/stream - ThreadHub: one DaemonAgentConnection per open thread
browser  -> POST api/threads/:id/prompt  ThreadHub.prompt -> connection.prompt(...)
```

- `src/chat-catalog.ts` keeps the session list. It subscribes to `roster_update`, refreshes `list all` and `cron_list` after a short debounce, merges tags and priority from `src/chat-labels.ts`, and pushes the projected rows and tags to every open browser.
- `src/chat-threads.ts` keeps an attached connection per thread (up to 8 live, idle ones close after 3 minutes). On subscribe it sends one snapshot, then forwards native events. `message_update` is coalesced to one per 40 ms.
- `src/chat-projection.ts` trims payloads without renaming anything: tool output over 600 characters and long tool arguments get `truncated: true` and a fetch endpoint, thinking is cut to 240 characters, image bytes become `api/images/<hash>` URLs from a bounded memory store.
- `src/shared/thread-state.ts` is the reducer. The server and the browser apply the same events to the same `ThreadState`, so there is no polling and no DOM diffing.
- `src/shared/turns.ts` groups messages into turns for display. A user message always starts a turn; an agent message or background completion starts one only after the previous run settled.
- `src/shared/cache-health.ts` reads native per-call `usage` and flags broken caching.
- `src/client/` is the Svelte 5 app. `chat-assets.ts` bundles it in memory with esbuild when the service starts and serves it with an ETag.
- `src/chat-pool.ts` wraps `components/pi-pool/bin/pi-pool` with argument arrays. It never runs `pi-pool-token`. It drops the calling session's variables, so pi-pool resolves only the thread named with `--session`.

## HTTP API

All routes sit under the capability URL. Writes need JSON, the page token in `X-Chat-Token`, and the exact loopback `Origin`.

| Route | Purpose |
| --- | --- |
| `GET api/sessions/stream` | SSE list of top-level sessions |
| `GET api/threads/:id/stream` | SSE snapshot, then native events |
| `GET api/threads/:id/tool-output?toolCallId=` | full tool result text |
| `GET api/threads/:id/part?message=&part=` | full text of a truncated part |
| `GET api/threads/:id/commands`, `GET api/commands` | native commands and skills, for a thread or the new-chat screen |
| `GET api/threads/:id/stats` | native session stats: token totals with cache read and write, cost |
| `GET api/models?id=` | model catalog and current model |
| `GET api/workspaces` | recent working directories |
| `GET api/accounts?id=` | pool state for a thread |
| `GET api/images/:hash` | an image from the transcript |
| `GET api/labels` | saved tags and per-thread tags and priority |
| `POST api/threads` | create a thread and send the first message |
| `POST api/threads/:id/prompt` | send, queue or steer |
| `POST api/threads/:id/abort`, `rename`, `model`, `thinking`, `queue`, `read` | thread controls |
| `POST api/warm` | attach ahead of a click |
| `POST api/accounts` | pool actions |
| `POST api/labels` | `create`, `rename`, `delete` a tag; `tag` threads on or off; set `priority` 0 to 3 |

## Commands

```sh
node src/chat-service-cli.mjs start|serve|status|url|stop [--port 5182] [--socket PATH] [--data-dir PATH]
npm run typecheck      # tsc and svelte-check
npm test               # unit and service tests
npm run test:native    # isolated daemon, deterministic provider, real HTTP and SSE
```

The service keeps its configuration, instance record, read markers and labels (`labels.json`) under `~/.prime/agent/browser-chat` by default. Use `--data-dir` for a second instance.

## Limits

- Message text up to 32,000 characters. Up to 4 images per message, 3 MiB each, 8 MiB total, PNG, JPEG, GIF or WebP.
- Extension commands that need terminal dialogs are refused with a message. Prompt and skill commands work.
- The image store is in memory and bounded, so an image URL can expire after a restart. Reopen the thread to refresh it.

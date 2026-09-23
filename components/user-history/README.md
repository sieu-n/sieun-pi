# Browser chat for Prime Agent

A thin browser front end for native Prime Agent sessions. `/what-did-i-say` and `/agent-chat` in the terminal start or reuse the shared server and print its URL. Nothing opens a browser for you. Run `/reload` in the terminal after updating the extension.

Prime Agent owns every run, queue, name, model, skill and worker. The browser attaches to the daemon the same way the terminal's agents view does. Closing or refreshing a tab never stops a worker.

## What you see

- Sidebar: two tabs, Threads and Heartbeats. A thread with an active or paused heartbeat or cron job (daemon `cron_list`) sits under Heartbeats. Each tab sorts Needs response first, then Working, then the rest by priority and recent activity, or, with the Chronological sort, as one list by recent activity. The Filter button next to search opens the Agents view filters (status, tag, priority, progress, workspace, model) for the sidebar list and the sort choice; the button shows how many filters are on, and Clear resets them. Filter and sort are saved in the browser. Needs response means the thread is not running, has messages, and had activity after you last read it in the browser. A thread you open keeps its Needs response place while it stays open and the tab is visible; it counts as read when you open another thread or the tab goes hidden. Each card has two lines. The first is the title with a spinner while it works or a dot when it needs a response. The second is the age ("3d ago", nothing for a thread created today; or the heartbeat label and next run), the working time ("12m") while it runs, the session cost from the native session usage ("$0.00" when zero, a dash when the daemon reports none), a short model name ("opus-5.5", "astra-6"), tag chips, a 3-step progress mark and a priority mark of 0 to 3 bars. Hover a card for its actions: add a tag, archive, and the menu (rename, priority, progress, tags, archive). Right click or Shift+F10 opens the same menu. Archive works like Ctrl+X in the terminal agents view, for any thread: one click kills the resident session ("Unknown active session" counts as done), records the native archived state in the session file, and drops the server's own attachment. The row leaves the list at once (the server holds it as archived until the daemon list agrees), an open thread hands the view to the next thread in the sidebar or New chat, and a toast offers Undo for 6 seconds, which records the session as active again (it comes back as a saved thread that resumes on reply). Archived threads sit behind a toggle. Drag the right edge to set a width from 180 to 480 px; drag it under 120 px and the sidebar snaps closed, the same state as Cmd+B. A click or drag on the closed edge opens it again at the last width. The edge also takes Left/Right, Home/End and Enter. The width is saved in the browser.
- Freshness: a running thread's mark comes from the native daemon summary the sessions stream already carries (no extra polling): `lastActivityAt` of the thread or of its freshest running subagent, the one-line `summary`, `lastHeardFromAt` and the failed worker state. Live (activity in the last 60 s) keeps the spinner; quiet (1 to 5 min) dims it and shows "quiet 3m"; stalled (5 min or more, or the worker went silent) shows an amber dot and "no activity 41m"; failed (the worker failed, or the session is streaming while its summary reports a failing model call such as "Model request failed", a usage or rate limit, "Try again in" or a retry) shows a red dot and that line on row two, full text on hover. A thread that only waits on subagents often keeps an old failure line, so that alone does not count. The thresholds: a model call or tool streams events every few seconds, so a silent minute is unusual and five silent minutes means the run is stuck. The Agents view has a Stalled status filter and the same marks; the Subagents button adds an amber or red dot when a running child is stalled or failing, and each child row shows the same mark and text. In an open thread, the live work row shows how long the current tool call has run and "last event 12s ago" from the thread's own event stream, amber past 5 minutes.
- Tags: one tag picker everywhere (the card, the thread header, the menu, and the Agents bulk bar). Type to filter. Enter creates the typed tag and assigns it, or toggles the highlighted one. Assigned tags show as chips on top; a click on a chip, or Backspace in the empty field, removes one. In the thread header a click on a tag chip removes it.
- Progress: a label next to priority with the values none, plan, implementation and qa, saved with the tags and priority.
- Agents view: the list button at the top of the sidebar opens a table of every thread with search, filter menus (status, kind, tag, priority, progress, workspace, model) whose options show their real marks (tag chips in their color, priority bars, the progress steps, status dots), a created date range with presets and a month grid, sortable columns including cost, and a bulk bar for tags, priority, progress and archive. A click on a row's Tags, Priority or Progress cell opens the same picker as the sidebar for that row. Archived threads are hidden until you press Show archived. Up and Down move, Enter opens, Space selects, Cmd+A selects all.
- New chat: the default screen. A greeting and the composer. The bar under the input holds the workspace and account on the left (a click on the account opens the pool accounts for the selected model's provider: Follow the pool by default with its next pick named, each account with plan, usage meters and state; accounts that cannot serve are greyed and need a second click; another provider's model resets the choice) and the model and effort on the right. Under the composer, Tags, Priority and Progress set labels for the new thread with the same pickers as the sidebar (the tag picker can create a tag). The first send creates a resident native session with the chosen model and effort, runs `pi-pool use <account> --session <id>` when an account was chosen (a failed use sends nothing and keeps the draft), then prompts, so the first model request already uses that account. It attaches, streams the reply, and then writes the chosen labels to the new thread.
- Thread: the whole transcript, opened at the bottom. Only what the user typed is a bubble on the right; a skill invocation shows the typed text with a skill tag. Agent messages, heartbeats and background command completions show as one muted line that also holds the turn's work. The header is one 40 px row: the title (click to rename), the workspace, the tags with an add button, the Default and Questions switch, the subagents button and Archive. Questions lists every prompt, and a click jumps back to that turn in Default. In Default each turn shows the prompt, or a one-line trigger, and only its final reply. Everything else in the turn (thinking, tool calls, interim messages, system notes, agent messages that arrived mid-run) folds into one collapsed row such as "Worked 6m 12s · 39 tool calls · 3 notes". While the turn runs, that row shows the current step with a spinner and stays collapsed until you open it. Replies render as markdown with copy buttons. Errors and stopped replies stay visible.
- Subagents: the header button shows a spinner and "2 of 9" while any child runs, else the child count. It opens a list grouped Running, Failed, Done and Cancelled, with a filter box and an All / Running / Finished switch. Each row has the status, name, short model name, cost and run time, and a second line: for a running child its native activity ("Running bash", "Thinking", "Writing") and latest recap; for a finished one its answer preview, the error line, or Cancelled. A click opens the child's own transcript when the daemon lists its session. Rows render in a window, so hundreds of children stay fast. Cost and the session id come from the child sessions in the daemon list (matched by `rlmChildId`); the child snapshot carries status, activity, recap, error, answer preview, model and `durationMs`, but no start or finish time. Over 40 children the list opens in a dialog.
- Composer: Enter sends, Shift+Enter adds a line, "/" opens the native command and skill menu, images paste or drop in. The menu matches a skill with or without its `skill:` prefix and by description, and it works on the new-chat screen too. It lists the native session commands `/compact`, `/refine`, `/goal` and `/autonomous`; they run through the normal prompt path. While the agent works, Send becomes Steer and a Stop button appears. Only while the agent works, the arrow next to Send chooses what Enter does: Steer (the default) or Queue. Cmd+Enter does the other one. The choice is saved in the browser. Queued messages show as chips you can edit or remove.
- Model button: a search box (Enter picks the highlighted model, arrows move), Favorites (GPT-6 Astra, Claude Opus 5.5 and Claude Fable 5.1 by default; the star adds or removes one, saved in the browser), the other models by provider, and an Effort row with the model's native thinking levels. On a thread, native `setModel` and `setThinkingLevel` also set the default for new chats. Menus open as top-layer panels that flip above or below to stay on screen.
- Context: hover or focus the ring to see context tokens, session cost, input, output, cache read and cache write totals from native `getSessionStats`, and the last call's cache hit rate from its native `usage`. A dot flags a cache problem: red when a warm call (same model, under 5 minutes after the previous call, prompt of 10k tokens or more) reads under 50% from the cache; amber when it reads under 90%, or 10 points under the thread's median, when it writes more than 20% of its prompt to the cache, or when 2 of the last 20 warm calls missed. The thresholds come from 13,583 warm calls in 40 recent threads (median hit 99.5%, p5 93.9%).
- Saved threads open read-only in a few hundred milliseconds. Sending a reply resumes them natively.
- Account: the composer bar shows the thread's account by full email, with one meter per usage window in one style (label, percent, a 4 px bar that turns amber at 70% and red at 90%). Claude shows 5h and Week, plus the Fable weekly cap only when the current model name contains "fable"; Codex shows the windows its plan has. Hover shows the reset times. A click opens Settings.
- Settings: a dialog opened from the account or the gear in the sidebar. Accounts is the first section. It has a tab per provider, an "Add Claude account" or "Add Codex account" button, the sentence "This thread uses X (reason)", and one row per account: email, plan, one state badge (off, seat, live, pinned, depleted, cooldown, refused, needs login) and every usage window with its percent and "resets in 3h 46m". A click on a row uses that account for the open thread; an account that cannot serve asks first, and an account that is off is never picked. Off rows are dimmed and show Turn on. Needs-login rows show Sign in again. The row menu holds Use for this thread, Pin or Unpin for all sessions, Drop seat, Check again (re-probe refused Claude accounts), Sign in again, Turn off or Turn on, and Remove, which asks you to type the email. Add account and Sign in again run `pi-pool login`: the page opens the sign-in page in a new tab, shows the Codex device code with a copy button or a paste box for the Claude code, and streams the status until it is done, failed or cancelled. One sign-in runs at a time and the service stops it after 10 minutes. The refresh button asks tokenmaxxing to read every account's usage now.

Keyboard: Cmd+N new chat with the composer focused, Cmd+K the Agents view with its search focused, Cmd+B sidebar, Esc closes menus or stops a busy thread when the composer has focus, arrows and Enter move and pick in lists and menus. Use `/compact` in the composer to compact context.

Look: the Virev tokens (graphite neutrals, ocean accent, raised menus with a strong hairline and a float shadow, flat mode switches) ported into `src/client/app.css`. Tooltips appear only on icon buttons. All spinners turn in one phase, one page clock drives every timer, and it stops while the tab is hidden. Light and dark follow the OS. Below 900 px the sidebar becomes an overlay.

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
- `src/client/` is the Svelte 5 app. `src/client/ui/` holds the shared controls: `Floating` (top-layer anchored panel), `Select`, `DateRange`, `Checkbox`, `TagPicker` and the `tooltip` action. `chat-assets.ts` bundles it in memory with esbuild when the service starts and serves it with an ETag.
- `src/chat-pool.ts` wraps `components/pi-pool/bin/pi-pool` with argument arrays. `poolCommand` holds the exact command lines for off, on, rm and login. `AccountLogins` runs one `pi-pool login` child at a time: stdout JSON lines become the login state, a pasted code goes to its stdin, cancel closes stdin, then SIGTERM and SIGKILL follow; its own deadline backs up `--timeout 600`. It never runs `pi-pool-token`. It drops the calling session's variables, so pi-pool resolves only the thread named with `--session`.

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
| `GET api/labels` | saved tags and per-thread tags, priority and progress |
| `GET api/threads/:id/child-usage` | native usage cost of each subagent of a thread |
| `POST api/threads` | create a thread and send the first message |
| `POST api/threads/:id/prompt` | send, queue or steer |
| `POST api/threads/:id/abort`, `rename`, `model`, `thinking`, `queue`, `read`, `archive` | thread controls |
| `POST api/warm` | attach ahead of a click |
| `POST api/accounts` | pool actions: use, follow, pin, unpin, switch, refresh, recheck, disable, enable, remove |
| `GET api/accounts/login/stream` | SSE state of the current or last sign-in |
| `POST api/accounts/login`, `login/paste`, `login/cancel` | start a sign-in (add, or again with `account`), send a pasted code, cancel |
| `POST api/labels` | `create`, `rename`, `delete` a tag; `tag` threads on or off; set `priority` 0 to 3; set `progress` |

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

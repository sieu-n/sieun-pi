---
name: board
description: Read a browser chat's board, corrections and the log of outside sends from Python, set a kernel-free wake for a CI run or a time, plus the chat_board op rules and a VP chat's rules for jobs, check-ins and git.
---

# Board

A chat's board holds the plan of goals and steps, the owner's todos and the scratchpad. The chat server keeps it in `~/.prime/agent/browser-chat/boards/<chat session id>.json`. The `chat_board` tool shows only the open checklist, so read the rest with this module.

## Read the board

Call the pre-imported `board` module in the Python REPL. Each call returns plain text.

```python
board.open()               # open goals and steps, open todos, and a count of the rest
board.get("p220")          # one item in full: note, requirements, target JSON, linked todos, every step under it
board.get("t43")           # one todo, or board.get("s12") for one note and the notes under it
board.notes()              # the scratchpad with links
board.notes("cache")       # notes, step notes and requirements that name "cache"
board.done(since="p250")   # done and dropped steps from p250 on, with their notes
board.todos(all=True)      # every todo with its answer
board.corrections()        # every owner correction in force, in full
board.corrections("c12")   # one correction with the owner's words and what enforces it
board.sends("iwebfusion")  # every email, ticket reply or message an agent sent or tried to send there (c37)
```

Answer "did an agent send X anything" from `board.sends(...)`, never from the wiki or Aside memory. The send guards write one line to `~/.prime/agent/browser-chat/sends.jsonl` for each send they allow or refuse, with the session, time, target and OWNER_OK token. A backfill of the session transcripts adds the sends from 10-08 on. A `ran` line is a backfilled send that went out unchecked and that the guard would refuse today. From a shell in the sieun-pi checkout, read the same log with `node --import tsx components/user-history/src/send-log.ts --match <text>`, which also takes `--since`, `--chat` and `--decision ran`.

## Wait without a kernel

A job that waits for a CI run or a time sets a wake and ends its turn with nothing running. The chat service checks each wake every 30 s and sends the session an agent message that starts with `[wake]` when the run finishes or the time comes. That message reopens the session even after Prime unloaded it.

```python
board.wake(run=38556270524, note="land r11 on green")   # read from the local CI cache, so no GitHub call
board.wake(run=123, repo="sieu-n/sieun-pi")             # a run in another repo, read with gh every 2 min
board.wake(at="2026-10-14T22:30:00Z", note="remeasure") # a time, instead of bash("sleep ...")
```

Never end a turn with `bash("ci-run-status <id> --wait")`, `gh run watch`, or a `sleep` still running. Prime counts a session with a running bash handle as busy, so the session keeps its Python kernel and its worker for the whole wait. On 10-14, 125 of 152 working sessions waited that way and held 8.69 GB of kernels. A wait inside one turn that ends in under a minute can still use `await bash(...)`.

The same holds for any `bash()` handle that outlives its turn, such as a 3 h sampler. Run that command detached with `nohup <command> > <file> 2>&1 &` and set `board.wake(at=<its end>)`. The Mac usable watch asks the chat about every handle still held 30 min after its job's turn ended.

A single cell that pages an API or awaits a command for 30 min holds the kernel and worker the same way, and the job takes no message until it ends. On 10-15 wp-engage-crawl sat 32 min in one cell that paged the staging crawler API and lost the pull to a 502 at the end. Run such a pull as a detached script that writes its result to a file, set `board.wake(at=<its end>)`, and read the file when the wake comes. The Mac usable watch asks the chat about every session that has sat 30 min in one open tool call. A call whose kernel used no CPU, started no process and moved no socket bytes for 30 min counts as hung: the watch tells the chat, and one minute later it interrupts the call and tells the job to rerun the work detached. Give every network call a timeout.

A chat and every job under it find the chat from `RLM_SESSION_DIR`. A root job that a chat started with `rlm.create_session` has its own id, so it passes `chat="<chat session id>"`.

## Rules a VP chat reads on demand

The chat brief keeps one line per rule and points here for the detail of one kind of action.

1. `references/jobs.md` covers starting, briefing, splitting, steering and deleting jobs, and wiki page jobs.
2. `references/check-ins.md` covers the check-in, duties and heartbeats.
3. `references/git.md` covers sieun-pi commits, merges, pushes and promotes.
4. `references/owner.md` covers owner todos, review asks, logins, and links, images and diagrams in a reply.
5. `references/corrections.md` covers what to do when the owner corrects how a chat works.

## Plan shape

1. The plan is a nested checklist where top items are goals and their children are steps.
2. Every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build and Verify.
3. Each step carries its real status, including blocked steps nobody works on yet, so the owner sees the whole path.
4. Link a job on the step it does, not on the goal. Goal `Reach chats from a messenger (Slack first)` has Plan (doing, job messenger-bridge-research), Decide (blocked), Build (blocked), Verify (todo).
5. A step's `job` names its owner, which is a job name or another thread as `thread:<id>` or its session name.
6. A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.
7. Keep a few area goals, at most 6 open, and move a step filed in the wrong place with plan_update `parent`.

## Upkeep

1. Make the board match reality in the same turn a job starts, ends or replies, with real statuses and notes with links.
2. When a step's waitUntil passes or its job ends, act on it in that turn: record the job's result, do the next action, or close it done or dropped. Never leave an old wait showing (c44), and never wait again, because the board refuses a later waitUntil (c47).
3. When plan_add says an open goal covers the same area, put the work under that goal unless it is a separate area (c44).
4. When this chat's duty runs a goal's work, or every open step of a goal rides another goal's job, fold the goal in the same turn (c46). Move each open step under the goal or job that ships it with plan_update `parent`, then close the goal with a note that names the duty or goal holding its work.
5. When a step moves to another thread for good, remove it with plan_remove and add one scratch note naming its new owner, because that thread tracks it on its own board (c8).
6. A step that waits on another thread stays, with waitFor, only while more work of this chat comes after it.
7. A goal whose own work is done and whose last steps only wait on another thread (its release, its land, a check it owns) does not stay open (c45). Check the wait against the real state and close the goal on that evidence, or send that thread the leftover in one message and close the goal with a note naming the thread.
8. Send a job only its own plan item, never the whole board.
9. Keep the scratchpad a short bullet list with one finding or decision per bullet and links to what it is about, such as `job:<name>` for a job's report. Long detail such as findings, options and file paths goes there as bullets, never as long prose.
10. Put each decision the chat makes itself (a ruling between threads, a land order, a skipped re-probe, a kept or dropped limit) in the scratchpad as a dated note in the same turn, besides any step note or job message (c76). On 10-15 ops guy made a land order (05:41Z), a kept SUMMARY_MAX_KEYS limit (07:20Z), a "won't land" ruling on three runs (07:43Z) and a skipped re-probe (07:50Z) only in job and thread messages, and wrote dated notes only at 08:27Z, after the owner asked why it does not use the scratchpad. The chat server now sends a `[board] Decisions not on the scratchpad:` steer after a turn that sent a ruling and added no scratch note.
11. Write board notes and todos as plain sentences a person reads once, with no all-caps labels (SECURITY:, URGENT:), no slash-joined names, and no repo jargon (origin/main, xoxb, HEAD) when a plain word works. Say what it is and what happens next.

## chat_board ops

Ops apply in order, all or none. A refused op returns the reason and the fix.

1. `plan_set {items:[{text,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?,children?}]}` replaces the plan. An item that keeps its id keeps its go, kind, requirements, target and duty when you leave them out.
2. `plan_add {text,parent?,status?,job?,sessionId?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?}` adds a goal, or a step under `parent`. The plan holds at most 6 open goals, so new work goes under the goal it belongs to.
3. `plan_update {id,parent?,text?,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?}` changes an item. `null` clears job, sessionId, note, waitUntil, waitFor, kind, requirements, target or duty. `parent` moves the item with its steps to the end of that item's steps, and `parent: null` moves it to the top level.
4. `plan_remove {id}` removes an item and its steps.
5. `scratch_add {text,parent?,links?}`, `scratch_update {id,text?,links?}` and `scratch_remove {id}` edit the scratchpad. In `scratch_update`, `links` replaces the list and `[]` clears it.
6. `todo_add {text,choices?,step?,links?}` asks the owner one short question in plain words. Give 2 to 4 short choices, your recommendation first. `step` is the plan step it asks about. A todo that asks him to review, look at or pick something needs `links` to each exact page, or the URL in its text, and the board refuses it otherwise (c32).
7. `todo_update {id,text?,done?,links?}` edits a todo, and its `links` replaces the list. Only the owner answers a todo. `todo_remove {id}` removes it.

A link is `{label,target}`, up to 5 per note. The target is `job:<name>`, `thread:<session id>`, `thread:<session id>@<message timestamp ms>`, `wiki:<path under the llm-wiki content>`, `file:<absolute path>` or an http(s) URL.

A step keeps its agent's thread id in `sessionId`, so the link survives when the job is deleted or renamed. Set it to a session id, `thread:<id>` or a chat URL. A `job` that names a thread sets it too, and a new job clears the old one. The checklist and `board.get(id)` show it as `thread:<id>` next to the job.

## Gates and waits

### The owner's go

`go: "needed"` marks a step that ships, ports, deploys, merges into a shared app, or moves work from a demo or preview to a real app or production. That step and its children move to doing or done only after the owner answers a todo linked to it with a go. The mark never clears.

Until the proper launch the owner pre-approves every prod promote, merge or push to main (c74, 2026-10-15). While that standing go is on, a step that merges, pushes to main or master, promotes or names another production target moves with no todo, even when marked. Never put a promote, merge or push go on For you and never wait for one, because the board refuses a todo that asks for one. A step that sends something outside or publishes to a web store still needs the owner's answer on its todo (c37).

A step whose only target is staging never needs a go, even when marked. Such a step names staging, sieun/dev or a dev branch, or lands with no PR number, and it names no prod, production, promote, main, master or real app (owner 10-12).

The owner picking a design on a demo is not a go. Offer the go choice first, worded with Go, Ship or Yes, and a hold choice such as Not yet. A go said in chat does not count, so ask the owner to answer the todo. `references/git.md` holds the full merge rule, the one switch that turns the standing go off after launch, and the c49 rule with its OWNER_OK token that comes back then.

### Build steps and requirements

1. `kind: "build"` marks a Build step, and text that starts with "Build" counts too. It moves to doing only when its goal's requirements are all met with evidence, or carry a note.
2. `requirements: [{text,status,evidence?,note?}]` on a goal holds one line per owner requirement, quoting the owner's words, with status met, unmet or open.
3. Before a goal's Build step starts, the plan or design job quotes each line of the owner's request word for word and checks it against the design (c28).
4. A met line carries its evidence, and an unmet or open line the owner put off carries a note.

### Targets

`target: {metric,target,unit,current?,measuredAt?,source?,cadence?}` on a top-level goal is its measurable target, and higher is better. Give a goal one when it has a measurable outcome. Each time you measure, send the whole target with current, measuredAt (ISO) and source together. Use `cadence: "daily"` when a daily duty measures it.

The check-in lists every goal short of its target or not measured. Push the step that closes the largest gap, because waiting steps are not progress (c23).

### Duty fix steps

`duty: "<dutyId>/<metricKey>"`, like `"d6/usable_pct_24h"` or `"checkin/stuck_steps"`, marks a step as the fix for one duty metric. Give it a job that works on a code change. Each duty run reads these steps for its missed metrics, and closing one starts a verify run of the duty. The rules are in [check-ins](references/check-ins.md).

### Waits

`waitUntil` (an ISO time) or `waitFor` (the event or thread, in a few words) marks a step that waits on purpose. The check-in leaves it alone until that time, or for 2 h after your last change. Then it lists the step as due or as a stale chase. After 24 h a stale chase must become a For you todo or a new plan.

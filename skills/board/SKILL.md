---
name: board
description: Read a browser chat's board, corrections and the log of outside sends from Python, plus the chat_board op rules and a VP chat's rules for jobs, check-ins and git.
---

# Board

A chat's board is the plan of goals and steps, the owner's todos and the scratchpad. The chat server stores it in `~/.prime/agent/browser-chat/boards/<chat session id>.json`. The `chat_board` tool shows only the open checklist; read the rest with this module.

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

Answer "did an agent send X anything" from `board.sends(...)`, never from the wiki or Aside memory. The send guards write one line per send they allow or refuse, with the session, time, target and OWNER_OK token, and a backfill holds the sends from 10-08 on. A `ran` line is a send that went out before the guard stopped it. The same log reads from a shell with `node --import tsx components/user-history/src/send-log.ts --match <text>` in the sieun-pi checkout.

A chat and every job under it find the chat from `RLM_SESSION_DIR`. A root job that a chat started with `rlm.create_session` has its own id, so it passes `chat="<chat session id>"`.

## Rules a VP chat reads on demand

The chat brief keeps one line per rule and points here for the detail of one kind of action.

1. `references/jobs.md` covers starting, briefing, splitting, steering and deleting jobs, and wiki page jobs.
2. `references/check-ins.md` covers the check-in, duties and heartbeats.
3. `references/git.md` covers sieun-pi commits, merges, pushes and promotes.
4. `references/owner.md` covers owner todos, review asks, logins, and links, images and diagrams in a reply.
5. `references/corrections.md` covers what to do when the owner corrects how a chat works.

## Plan shape

1. The plan is a nested checklist: top items are goals, and their children are steps.
2. Every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build and Verify.
3. Each step carries its real status, including blocked steps nobody works on yet, so the owner sees the whole path.
4. Link a job on the step it does, not on the goal. Goal `Reach chats from a messenger (Slack first)` has Plan (doing, job messenger-bridge-research), Decide (blocked), Build (blocked), Verify (todo).
5. A step's `job` is its owner: a job name, or another thread as `thread:<id>` or its session name.
6. A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.
7. Keep a few area goals, at most 6 open, and move a step filed in the wrong place with plan_update `parent`.

## Upkeep

1. Make the board match reality, with real statuses and notes with links, in the same turn a job starts, ends or replies.
2. When a step's waitUntil passes or its job ends, act on it in that turn: record the job's result, do the next action, or close it done or dropped. Never leave an old wait showing (c44), and never re-wait, because the board refuses a later waitUntil (c47).
3. When plan_add says an open goal covers the same area, put the work under that goal, unless it is a separate area (c44).
4. When this chat's duty runs a goal's work, or every open step of a goal rides another goal's job, fold the goal in the same turn (c46). Move each open step under the goal or job that ships it with plan_update `parent`, then close the goal with a note naming the duty or goal that holds its work.
5. When a step moves to another thread for good, remove it with plan_remove and add one scratch note naming its new owner; that thread tracks it on its own board (c8).
6. A step that waits on another thread stays, with waitFor, only while more work of this chat comes after it.
7. A goal whose own work is done and whose last steps only wait on another thread (its release, its land, a check it owns) does not stay open (c45). Check the wait against the real state and close the goal on that evidence, or send that thread the leftover in one message and close the goal with a note naming the thread.
8. Send a job only its own plan item, never the whole board.
9. The scratchpad is a short bullet list: one finding or decision per bullet, with links to what it is about, such as `job:<name>` for a job's report. Long detail (findings, options, file paths) goes there, never long prose.
10. Board notes and todos are plain sentences a person reads once: no all-caps labels (SECURITY:, URGENT:), no slash-joined names, and no repo jargon (origin/main, xoxb, HEAD) when a plain word works. Say what it is and what happens next.

## chat_board ops

Ops apply in order, all or none. A refused op returns the reason and the fix.

1. `plan_set {items:[{text,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,children?}]}` replaces the plan. An item that keeps its id keeps its go, kind, requirements and target when left out.
2. `plan_add {text,parent?,status?,job?,sessionId?,waitUntil?,waitFor?,go?,kind?,requirements?,target?}` adds a goal, or a step under `parent`. The plan holds at most 6 open goals, so new work goes under the goal it belongs to.
3. `plan_update {id,parent?,text?,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?}` changes an item. `null` clears job, sessionId, note, waitUntil, waitFor, kind, requirements or target. `parent` moves the item with its steps to the end of that item's steps; `null` moves it to the top level.
4. `plan_remove {id}` removes an item and its steps.
5. `scratch_add {text,parent?,links?}`, `scratch_update {id,text?,links?}` (links replaces the list, `[]` clears it) and `scratch_remove {id}` edit the scratchpad.
6. `todo_add {text,choices?,step?}` asks the owner one short question. Give 2 to 4 short choices, your recommendation first. `step` is the plan step it asks the owner's go for.
7. `todo_update {id,text?,done?}` edits a todo; only the owner answers one. `todo_remove {id}` removes it.

A link is `{label,target}`, up to 5 per note. The target is `job:<name>`, `thread:<session id>`, `thread:<session id>@<message timestamp ms>`, `wiki:<path under the llm-wiki content>`, `file:<absolute path>` or an http(s) URL.

## Steps and their agents

A step keeps its agent's thread id in `sessionId`, so the link holds after the job is deleted or renamed. Set it to a session id, `thread:<id>` or a chat URL; a `job` that names a thread sets it too, and a new job clears the old one. The checklist and `board.get(id)` show it as `thread:<id>` next to the job.

## Gates and waits

1. `go: "needed"` marks a step that ships, ports, deploys, merges into a shared app, or moves work from a demo or preview to a real app or production. It and its steps move to doing or done only after the owner answers a todo linked to it with a go. The mark never clears. A step whose text merges a PR or a branch, turns on auto-merge, lands code or pushes to main or master needs the go without the mark, and the approving todo's text must name the PR it names, or say push (c49). A step whose only target is staging never needs a go, even when marked: it names staging, sieun/dev or a dev branch, or lands with no PR number, and names no prod, production, promote, main, master or real app (owner 10-12).
2. The owner picking a design on a demo is not a go. Offer the go choice first, worded with Go, Ship or Yes, and a hold choice like Not yet. A go said in chat does not count, so ask the owner to answer the todo. The check-in reports a merge step done without its go as a repo rule breach. The full merge rule and the OWNER_OK token are in `references/git.md`.
3. `kind: "build"` marks a Build step; text that starts with "Build" counts too. It moves to doing only when its goal's requirements are all met with evidence, or carry a note.
4. `requirements: [{text,status,evidence?,note?}]` on a goal has one line per owner requirement, quoting the owner's words. Status is met, unmet or open. Before a goal's Build step starts, the plan or design job quotes each line of the owner's request word for word and checks it against the design (c28). A met line carries its evidence, and an unmet or open line the owner put off carries a note.
5. `target: {metric,target,unit,current?,measuredAt?,source?,cadence?}` on a top-level goal is its measurable target; higher is better. Give a goal one when it has a measurable outcome. Send current, measuredAt (ISO) and source together, and send the whole target each time you measure it. Use `cadence: "daily"` when a daily duty measures it.
6. The check-in lists every goal short of its target or not measured. Push the step that closes the largest gap, because waiting steps are not progress (c23).
7. `waitUntil` (an ISO time) or `waitFor` (the event or thread, in a few words) marks a step that waits on purpose. The check-in leaves it until that time, or for 2 h after your last change, and then lists it as due or as a stale chase. After 24 h a chase becomes a For you todo or a new plan.

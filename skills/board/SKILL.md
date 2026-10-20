---
name: board
description: Read a browser chat's board, corrections and the log of outside sends from Python, set a kernel-free wake for a CI run or a time, record the paths and units a job throws away, plus the chat_board op rules and a VP chat's rules for jobs, check-ins and git.
---

# Board

A chat's board holds the plan of goals and steps and the owner's todos. The chat server keeps it in `~/.prime/agent/browser-chat/boards/<chat session id>.json`. The `chat_board` tool shows only the open checklist, so read the rest with this module.

## Read the board

Call the pre-imported `board` module in the Python REPL. Each call returns plain text.

```python
board.open()               # open goals and steps, open todos, and a count of the rest
board.get("p220")          # one item in full: note, requirements, target JSON, linked todos, every step under it
board.get("t43")           # one todo
board.done(since="p250")   # done and dropped steps from p250 on, with their notes
board.todos(all=True)      # every todo with its answer
board.corrections()        # every owner correction in force, in full
board.corrections("c12")   # one correction with the owner's words and what enforces it
board.sends("iwebfusion")  # every email, ticket reply or message an agent sent or tried to send there (c37)
```

Answer "did an agent send X anything" from `board.sends(...)`, never from the wiki or Aside memory. The send guards write one line to `~/.prime/agent/browser-chat/sends.jsonl` for each send they allow or refuse, with the session, time, target and OWNER_OK token. A backfill of the session transcripts adds the sends from 10-08 on. A `ran` line is a backfilled send that went out unchecked and that the guard would refuse today.

## Wait without a kernel

A job that waits for a CI run or a time sets a wake and ends its turn with nothing running. The chat service checks each wake every 30 s and sends the session an agent message that starts with `[wake]` when the run finishes or the time comes. That message reopens the session even after Prime unloaded it. On a box without the chat role in `~/.config/sieun-pi/hosts.json`, such as the Mac, the wake and every read go to the chat host's API, and the chat host delivers the wake through this box's relay.

```python
board.wake(run=38556270524, note="land r11 on green")   # read from the local CI cache, so no GitHub call
board.wake(run=123, repo="sieu-n/sieun-pi")             # a run in another repo, read with gh every 2 min
board.wake(at="2026-10-14T22:30:00Z", note="remeasure") # a time, instead of bash("sleep ...")
```

Never end a turn with `bash("ci-run-status <id> --wait")`, `gh run watch`, or a `sleep` still running. Prime counts a session with a running bash handle as busy, so the session keeps its Python kernel and its worker for the whole wait. On 10-14, 125 of 152 working sessions waited that way and held 8.69 GB of kernels. A wait inside one turn that ends in under a minute can still use `await bash(...)`.

The same holds for any `bash()` handle that outlives its turn, such as a 3 h sampler. Run that command detached, with no `nice` in front, and set `board.wake(at=<its end>)`.

1. On a Linux box, run `systemd-run --user --unit=<name> --collect --same-dir -E PATH sh -c '<command> > <file> 2>&1'`. After the wake, `systemctl --user status <name>` shows a run still going, and a finished run's unit is gone, so read the file. Pass any other variable the command needs with another `-E <NAME>`.
2. Never start it there with `nohup` from `bash()`. On 10-18 on us-metal02, r3f's clean-room collect, started with `(nohup node ... &)` at 07:33Z, died with no output when its session ended its turn on a `board.wake`, and a release chat's run started the same way died too.
3. On the Mac, run `nohup <command> > <file> 2>&1 &`.

A single cell that pages an API or awaits a command for 30 min holds the kernel and worker the same way, and the job takes no message until it ends. On 10-15 wp-engage-crawl sat 32 min in one cell that paged the staging crawler API and lost the pull to a 502 at the end. Run such a pull as a detached script that writes its result to a file, set `board.wake(at=<its end>)`, and read the file when the wake comes. Give every network call a timeout.

A chat and every job under it find the chat from `RLM_SESSION_DIR`. A root job that a chat started with `rlm.create_session` has its own id, so it passes `chat="<chat session id>"`.

## Record what a job throws away

When a job is deleted or archived, the chat service stops the transient systemd user units (`systemd-run`) and deletes the paths that the job's own record names and the job's own scratch folder `~/scratch/<its session id>/`, which its job line names, and nothing else. Put a throwaway tree in that folder and it needs no record. A path that a transcript or a command only names is never deleted or signalled, because on 10-19 at 02:06Z the end of job metal agent verification deleted the shared `~/scratch/release-applied` and stopped four release processes of other jobs that ran a helper from it.

```python
board.own("/tmp/p8iso-a", unit="p8iso-a-daemon.service")        # a rig and the systemd-run unit that serves it
```

The Prime kernel records most of it for you. Each folder under `~/scratch` that a cell makes, by Python or by a command it starts, goes into the record when it is made, unless it existed before or lies in a job's own `~/scratch/<session id>/` folder (global-rules `kernel-own.py`). Call `board.own` for the rest, such as a path under `/tmp`, a path a process outside the kernel made, or a unit.

Only the owner, or a job's end through its own record, deletes a tree on a box. A disk cleanup never deletes another job's tree, however ended it looks, and lists the path, its size and its likely owner for the chat that owns it instead. The kernel enforces this below `~/scratch`: it refuses an `rm -r`, a `find ... -delete` or a `shutil.rmtree` of a tree this job did not make with `TreeRefused` (global-rules `kernel-own.py`). A tree this job made is a path in an `owned.json` of this session, the sessions above it or its subagents, a folder in their own `~/scratch/<session id>/` folders, or a folder the kernel made. On 10-19 the box-scratch-sweep deleted live work by guessing which trees had ended, and on 10-20 at 04:00Z the scratch-r3 pass of the job wiki box disk fix guessed again and deleted `~/scratch/crawler-lab-window-2/build-b12` and `build-b13`, which a live Crawler ops job still needed. Never record another job's tree with `board.own` to get past the refusal. A tree under `~/work/<job>/` holds that job's evidence, and only that job deletes it.

1. Record only what is yours to throw away, such as an export, a rig, a data copy or a `systemd-run` unit.
2. Never record a report, evidence or a helper another job runs, and keep reports and evidence under `~/work/<job>/`.
3. A path must lie below `/tmp`, `~/scratch` or `~/.prime/agent/session-artifacts`, outside every session folder.
4. The record is `owned.json` in `RLM_SESSION_DIR`. A recorded path that a process still runs in, holds or names stays until a later sweep finds it free.
5. A server the owner asked to keep running is never a `systemd-run` unit and never recorded here, because sweeps stop a transient unit whose job has ended, and `Restart=always` does not undo a manual stop. On 10-19 at 21:34:14Z the Mac's metal agent queue job read its leftover survey on us-metal02, marked the transient unit `readme-4f1c45a` that served a page the owner had said to leave up as gone with its dead kernel, and stopped it with `systemctl --user stop` over ssh. Write `~/.config/systemd/user/<name>.service` with `StartLimitIntervalSec=0` and `RefuseManualStop=yes` under `[Unit]` and `Restart=always` under `[Service]`, put its takedown steps in a comment in that file, run `systemctl --user enable --now <name>`, and check that `loginctl show-user $USER -p Linger` says yes.

## Rules a VP chat reads on demand

The chat brief keeps one line per rule and points here for the detail of one kind of action.

1. `references/jobs.md` covers starting, briefing, splitting, steering and deleting jobs, and wiki page jobs.
2. `references/check-ins.md` covers the check-in, duties and heartbeats.
3. `references/git.md` covers sieun-pi commits, merges, pushes and promotes, and the auto-sns-agent branch model.
4. `references/owner.md` covers owner todos, review asks, logins, and links, images and diagrams in a reply.
5. `references/corrections.md` covers what to do when the owner corrects how a chat works.
6. `references/clean-room.md` covers the clean-room run that closes a harness, skill or tool change.
7. `references/plan-and-duties.md` covers what goes in the plan, in duties and on a risk page, how a duty run works, and the fix when the owner asks to fix plan and duties.

## Plan shape

1. The plan is a nested checklist where top items are goals and their children are steps.
2. Every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build and Verify. Its note starts with "Done when" and the check the owner would make by hand.
3. Each step carries its real status, including blocked steps nobody works on yet, so the owner sees the whole path.
4. Link a job on the step it does, not on the goal. Goal `Reach chats from a messenger (Slack first)` has Plan (doing, job messenger-bridge-research), Decide (blocked), Build (blocked), Verify (todo).
5. A step's `job` names its owner, which is a job name or another thread as `thread:<id>` or its session name.
6. A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.
7. Keep a few area goals, and move a step filed in the wrong place with plan_update `parent`. A goal with a target stays a goal under an area goal, so it keeps its number, trend and push step. Past 6 open goals the check-in flags only a goal with no number or no live owner job.

## Plan and duties

1. A plan step is a task that finishes. It comes from an owner request, has a "Done when" line, a live owner and a next action, and ends done or dropped.
2. A duty is standing upkeep of something that breaks easily, runs on a heartbeat, and acts like the engineer who owns that system.
3. A title that says keep, stays, always, every ... is green, every ... reads clean or keeps working is upkeep, so it becomes a duty metric and never a plan step.
4. A request with both parts gets one plan step for the fix and one duty metric for the keeping.
5. A goal that reaches its done line closes, and its upkeep becomes a duty metric that puts a fix step back on the plan when it misses.
6. Goals are 3 to 6 measured outcomes in the owner's terms, like "Instagram profiles crawl at 10k a minute, held 6 h", with the work steps under the goal they serve.
7. A problem that kept coming back in the thread becomes a duty metric, and a goal that is met and held long enough moves its metric into a duty.
8. A standing risk lives on a wiki risk page that a duty checks, never as a plan step.
9. The chat and its check-in push every open step toward done in each run, by resuming its job, starting a fix job, or closing it with evidence.

[plan-and-duties](references/plan-and-duties.md) has the owner's words, the Crawler VP example, the fix when he asks to fix plan and duties, and how a duty run works.

## Upkeep

1. Make the board match reality in the same turn a job starts, ends or replies, with real statuses and notes with links.
2. When a step's waitUntil passes or its job ends, act on it in that turn: record the job's result, do the next action, or close it done or dropped. Never leave an old wait showing (c44), and never wait again: a later waitUntil is no answer, and the board flags it (c47).
3. When plan_add says an open goal covers the same area, put the work under that goal unless it is a separate area (c44).
4. When this chat's duty runs a goal's work, or every open step of a goal rides another goal's job, fold the goal in the same turn (c46). Move each open step under the goal or job that ships it with plan_update `parent`, then close the goal with a note that names the duty or goal holding its work.
5. When a step moves to another thread for good, remove it with plan_remove and name its new owner in its goal's note, because that thread tracks it on its own board (c8).
6. A step that waits on another thread stays, with waitFor, only while more work of this chat comes after it.
7. A goal whose own work is done and whose last steps only wait on another thread (its release, its land, a check it owns) does not stay open (c45). Check the wait against the real state and close the goal on that evidence, or send that thread the leftover in one message and close the goal with a note naming the thread.
8. Send a job only its own plan item, never the whole board.
9. Put each decision the chat makes itself, such as a ruling between threads, a land order or a kept limit, in the note of the step it concerns in the same turn. The board has no scratchpad: the owner removed it on 10-15, and a `scratch_add`, `scratch_update` or `scratch_remove` op is refused.
10. Write step notes and todos as plain sentences a person reads once, with no all-caps labels (SECURITY:, URGENT:), no slash-joined names, and no repo jargon (origin/main, xoxb, HEAD) when a plain word works. Say what it is and what happens next.

## chat_board ops

Ops apply in order, all or none. A malformed op, an id that is not on the board, or an op only the owner may make refuses the whole batch with the reason and the fix. Text, lists and counts have soft targets (BOARD_LIMITS), and the c32 todo checks, the c47 wait checks and the upkeep title check are flags too: the op is saved and its summary gets one more line that says what to fix, so fix it in the same turn.

1. `plan_set {items:[{text,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?,children?}]}` replaces the plan. An item that keeps its id keeps its go, kind, requirements, target and duty when you leave them out.
2. `plan_add {text,parent?,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?}` adds a goal, or a step under `parent`. New work goes under the goal it belongs to.
3. `plan_update {id,parent?,text?,status?,job?,sessionId?,note?,waitUntil?,waitFor?,go?,kind?,requirements?,target?,duty?}` changes an item. `null` clears job, sessionId, note, waitUntil, waitFor, kind, requirements, target or duty. `parent` moves the item with its steps to the end of that item's steps, and `parent: null` moves it to the top level.
4. `plan_remove {id}` removes an item and its steps.
5. `todo_add {text,choices?,step?,links?}` asks the owner one short question in plain words. Give 2 to 4 short choices, your recommendation first. `step` is the plan step it asks about. A todo that asks him to review, look at or pick something needs `links` to each exact page, or the URL in its text, and the board flags it otherwise (c32).
6. `todo_update {id,text?,done?,links?,choices?}` edits a todo, and its `links` replaces the list. `choices` gives an open ask tap answers in place, or `null` clears them, so a free-text review the owner has left open gets a one-tap answer without a re-post that resets its age. Only the owner answers a todo. `todo_remove {id}` removes it.

A link is `{label,target}`, about 5 at most per todo. The target is `job:<name>`, `thread:<session id>`, `thread:<session id>@<message timestamp ms>`, `wiki:<path under the llm-wiki content>`, `file:<absolute path>` or an http(s) URL.

A step keeps its agent's thread id in `sessionId`, so the link survives when the job is deleted or renamed. Set it to a session id, `thread:<id>` or a chat URL. A `job` that names a thread sets it too, and a new job clears the old one. The checklist and `board.get(id)` show it as `thread:<id>` next to the job.

## Gates and waits

### The owner's go

`go: "needed"` marks a step that ships, ports, deploys, merges into a shared app, or moves work from a demo or preview to a real app or production. That step and its children move to doing or done only after the owner answers a todo linked to it with a go. The mark never clears.

Until the proper launch the owner pre-approves every prod promote, merge or push to main (c74, 2026-10-15). While that standing go is on, a step that merges, pushes to main or master, promotes or names another production target moves with no todo, even when marked. Never put a promote, merge or push go on For you and never wait for one. A step that sends something outside or publishes to a web store still needs the owner's answer on its todo (c37).

A step whose only target is staging never needs a go, even when marked. Such a step names staging, sieun/dev or a dev branch, or lands with no PR number, and it names no prod, production, promote, main, master or real app (owner 10-12).

The owner picking a design on a demo is not a go. Offer the go choice first, worded with Go, Ship or Yes, and a hold choice such as Not yet. A go said in chat does not count, so ask the owner to answer the todo. `references/git.md` holds the full merge rule and names `releaseGo.preapproval`, the switch that turns the standing go off after launch.

### Build steps and requirements

1. `kind: "build"` marks a Build step, and text that starts with "Build" counts too. Start it only when its goal's requirements are all met with evidence, or carry a note.
2. `requirements: [{text,status,evidence?,note?}]` on a goal holds one line per owner requirement, quoting the owner's words, with status met, unmet or open.
3. Before a goal's Build step starts, the plan or design job quotes each line of the owner's request word for word and checks it against the design (c28).
4. A met line carries its evidence, and an unmet or open line the owner put off carries a note.

### Targets

`target: {metric,target,unit,current?,measuredAt?,source?,cadence?,direction?}` on a goal at any depth is its measurable target. Give a goal one when it has a measurable outcome. Set `direction` to `"down"` when lower is better, such as a wait or a run time, and to `"up"` when higher is better. Without one, the board stores the direction its numbers show when the target is set, so a target under its current reading is lower is better, and a target of 0 is always lower is better. The stored direction stays on later writes that leave it out, and only an op that names a new direction changes it. Each time you measure, send the whole target with current, measuredAt (ISO) and source together. Use `cadence: "daily"` when a daily duty measures it.

The check-in lists every goal short of its target or not measured. Push the step that closes the largest gap, because waiting steps are not progress (c23).

### Duty fix steps

`duty: "<dutyId>/<metricKey>"`, like `"d6/usable_pct_24h"` or `"checkin/stuck_steps"`, marks a step as the fix for one duty metric. Give it a job that works on a code change. Each duty run reads these steps for its missed metrics, and closing one starts a verify run of the duty. The rules are in [check-ins](references/check-ins.md).

### Waits

`waitUntil` (an ISO time) or `waitFor` (the event or thread, in a few words) marks a step that waits on purpose. The check-in leaves it alone until that time, or for 2 h after your last change. Then it lists the step as due or as a stale chase. After 24 h a stale chase must become a For you todo or a new plan.

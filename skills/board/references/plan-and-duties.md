# Plan and duties

Read this when the owner says "fix plan and duties based on the board skill and pursue completion of plans", and at every check-in that finds a standing risk in the plan. Follow the whole procedure in one turn, then keep pushing until the end state below holds.

## The owner's words

The owner, 2026-10-18, after he found the ops guy's p45 and p221 at 64 of 71 and 60 of 69 steps, most of them standing risks such as "us-metal01 filesystem fills within 30 days", each waiting for another chat:

1. "a chat is a VP/TL responsible of a certain project scope."
2. "plan is meant to all be done, without intervention. a Job (employee) returns? -> VP pushes task to completion, tracks progress, identifies naturally emerging plan changes."
3. "only thing that stops completion of all plan is a blocker VP cannot resolve, which piles up in FOR YOU, but non-immediately blocking things should all be done automagically where possible."
4. "duties are things things the VP needs to maintain long term, typically things easy to break, need maintancence. like "keep crawler working", "keep CI working", "make wiki clean, skill&tools all relevant up to date". defines what the user expectation is, what user would do to verify naturally -> agent should check that too."
5. "things are meant to be first written in plan -> achieved -> cleared & written on duty for maintanence only -> and valiantly persued whenever not met. JUST DO IT"

## What goes where

| Item | Where it lives | Example |
|---|---|---|
| Work that can finish, from an owner request | A plan goal with a done line, its steps owned by live jobs | Overhaul the obs.virev.ai dashboards so the useful ones track the boxes and alert |
| A standing risk that may happen some day | One line on the chat's risk page on the wiki, checked by a duty metric | us-metal01 filesystem fills within 30 days |
| Long-term upkeep of something easy to break | A duty metric, measured the way the owner would check by hand | Keep the crawler working, keep CI working |
| Finished or stale work | Closed on the board with its evidence | A fix that shipped, or a step nobody needs now |

## Fix the plan

1. Read `board.open()` and `board.get(id)` for each open goal, and tag each open goal and step as work, risk, upkeep, or done or stale.
2. Close each done or stale step in the same batch, done with the evidence you checked or dropped with the reason.
3. Move each risk to one line on the chat's risk page, a wiki page named for the chat's area that a job writes, with how it is checked and what to do when it fires. Make sure a duty metric counts the risks that fire, then remove the step with `plan_remove` and name the page and the duty in its goal's note.
4. Move each upkeep step into a duty metric, as in "Fix the duties" below, then remove the step and name the duty in its goal's note.
5. A goal whose open steps were all risk or upkeep closes, with a note naming the page and the duty that now hold it.
6. Give each kept goal a done line: its note starts with "Done when" and the check the owner would make by hand, and a goal with a number also carries a `target`.
7. Give each open step a live owner, which is a job at work or asleep on a `board.wake`, or block it only on an open For you todo that links it. Start a job for each step that has neither, in the same turn.
8. A step that waits on another thread stays only while more of this chat's work comes after it (Upkeep 6 and 7). Send that thread the ask once with the step's words, and check the real state at the next wake.

## Owner blockers

1. Before a step waits on the owner, do every part that does not need him. For a paid cloud version of a tool, build and test against the self-hosted version, run the E2E tests, and have the code and the switch ready, so his step is one card number and takes seconds.
2. The For you todo then says what is ready and the one thing he does.
3. A strategy question or a review ask goes on For you with your pick first, and the work goes on with that pick while he decides. Never hold a step for it.

## Fix the duties

1. List the chat's duties in `~/.prime/agent/browser-chat/duties/<chat session id>.json`.
2. Each duty keeps one thing easy to break working for the long term, named after that system in the owner's terms, such as "Crawler working" or "CI working" ([check-ins](check-ins.md) 7 and 8).
3. Each metric reads what the owner would check by hand, such as the dashboard he opens or the page he loads, never a count of runs or files.
4. Every upkeep item and every risk page from the plan has a metric that checks it. Add the missing ones with `scripts/duties/add.ts` ([check-ins](check-ins.md) 6).
5. When a goal reaches its done line, check the real state, close the goal, and add a duty metric that keeps it met. When that metric misses later, its fix step goes back on the plan with a job ([check-ins](check-ins.md) 12).

## Pursue completion

1. When a job reports with work left on its step, send it the next action in the same turn, or start a job for it when it ended.
2. Record each change the work turns up in the same turn: add the step it needs, drop what no longer matters, and move a misfiled step with `plan_update parent`.
3. Never let a step sit without a live owner or a For you blocker until the next check-in.

## End state

1. The plan holds no standing risk and no upkeep step.
2. Every open goal has a "Done when" line, and every open step has a live owner or an open For you todo that links it.
3. Every upkeep item and risk is checked by a duty metric.
4. The plan's open steps go down each day as jobs finish them.

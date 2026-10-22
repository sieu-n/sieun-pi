# Plan and duties

Read this before you add a goal, a step or a duty, and when the owner says "fix plan and duties based on the board skill and pursue completion of plans". Follow the whole procedure in one turn, then keep pushing until the end state below holds.

## The rule

1. A plan step is a task that finishes, and every plan is short-lived.
2. Each step comes from an owner request and has a done line, a note that starts with "Done when" and names the check the owner would make by hand.
3. Each open step has a live owner and a next action, and it ends done or dropped.
4. A duty is standing upkeep of something that breaks easily, and it runs on a heartbeat.
5. Each duty run acts like the engineer who owns that system, as "How a duty run works" below says.
6. A title that says keep, stays, always, every ... is green, every ... reads clean or keeps working describes upkeep, so it becomes a duty metric and never a plan step.
7. A request with both parts, like "fix the broken wiki search and make sure it keeps working", becomes one plan step for the fix and one duty metric for the keeping.
8. A goal that reaches its done line closes, and any upkeep it leaves becomes a duty metric that puts a fix step back on the plan when it misses.
9. The chat and its check-in push every open step toward done in each run, by resuming its job, starting a fix job, or closing it with evidence.
10. Only a blocker the chat cannot clear goes to For you, and everything around it is ready so the owner's part takes seconds.
11. Goals are a few outcomes in the owner's terms, 3 to 6 open at a time, each measured with a current value, a target and when it was read, and each one finishes.
12. The work steps sit under the goal they serve, and a step that no owner intent backs is dropped with a note.
13. A problem that kept coming back in the thread, fixed or hit more than once, becomes a duty metric, not a plan step.
14. A goal or step whose target reads met closes in the same turn, with a note that names the reading, when a duty keeps its metric. The duty puts a fix step back when it slips, so nothing waits for one more reading (owner 10-22: "that's already being handled by the duty system. so then close it!!"). A hold the owner named in the goal, like "held 6 h", is part of its target. When no duty keeps the metric yet, add it to a duty first, then close the item. chat_board's reply and the check-in's met_open list name each such item.

## The owner's words

The owner, 2026-10-18, after he found the ops guy's p45 and p221 at 64 of 71 and 60 of 69 steps, most of them standing risks such as "us-metal01 filesystem fills within 30 days", each waiting for another chat:

1. "a chat is a VP/TL responsible of a certain project scope."
2. "plan is meant to all be done, without intervention. a Job (employee) returns? -> VP pushes task to completion, tracks progress, identifies naturally emerging plan changes."
3. "only thing that stops completion of all plan is a blocker VP cannot resolve, which piles up in FOR YOU, but non-immediately blocking things should all be done automagically where possible."
4. "duties are things things the VP needs to maintain long term, typically things easy to break, need maintancence. like "keep crawler working", "keep CI working", "make wiki clean, skill&tools all relevant up to date". defines what the user expectation is, what user would do to verify naturally -> agent should check that too."
5. "things are meant to be first written in plan -> achieved -> cleared & written on duty for maintanence only -> and valiantly persued whenever not met. JUST DO IT"

The owner, 2026-10-19 about 13:40Z, after the AI harness chat's goal "Every duty in every chat is green" sat open at 102 of 109 and "Every minute on us-metal02 reads clean" stayed open as a goal:

1. "plan should be tasks all eventually clear"
2. "duties are things that need constant montiroing thus set a heartbeat."
3. "things like "i need to keep X working" should NOT be registered as a zombie plan. ALL PLANS SHOULD BE EPHEMERAL, and the Chat (and Chat-check-in) MUST BE DESIGNED SO THAT IT ACTIVELY PERSUES AND CLEARS ALL THE TASKS."
4. "Duties are similar, but a flexible, sensible agent-centric way of keeping something in good shape. The goal should be really well aligned with human intent, and agent essentially acts as an engineer. What can be automated via script -> automate. however check and analyze observability that and make SENSIBLE decisions is the only goal. if a rule is unsensible -> change rule. no nitpicking, should have real impact, and the system in question error prone."

The owner, 2026-10-19 about 15:32Z, on how crawler-v3's plans should look (msg mvfe8foz, then mvfe930k):

1. "for example of instagram crawling workers, i think set it NOW to <plans>: they aren't achieved yet p1- achieve 10k profiles/min throughput instagram profile consistently for 6h + p2- nothing is backlogging ... p3- confidently discover and index ALL instagram creators (1000follower+)in the world (initial crawl) should be 200M + p4- make a system where all profiles are updated at least once every 2 week p5- make the crawler durable ... actually simulate this. p6- setup an ALerting system where alerts come DIRECTLY to that crawler VP thread"
2. "<duties>: ... Keep crawler running actively - Check the Observability and Metrics - Geonode mbps >=100mbps always - (when p1, p2,p4 is achieved, withinnitial stability 6h+ check, they now should come to duty.)"
3. "when p6 is achieved, it is your duty to keep LGTM and Grafana dashbaords up to date to any changes, and carefully tune the alerts system. if it's false alert -> try to reduce it change condition. if alert missed it ... add that alert"
4. "이런 느낌으로 푸쉬해줘. 모든 쓰레드에서 user intent를 분석하고, 꾸준히 발생했던 문제는 duties로 묶어야 돼." In English, he asked to push every thread to this shape, to analyze the owner's intent in each thread, and to group problems that kept coming back into duties.

## The main example, the Crawler VP's Instagram board

The owner set this plan for the Crawler VP's Instagram crawling on 10-19. It has six measured goals, and none of them is met yet. The done lines are the checks he named.

| Goal | Done when |
|---|---|
| p1 Instagram profiles crawl at 10k a minute | The rate holds at 10k profiles a minute or more for 6 h on the crawler dashboard |
| p2 Nothing backlogs | Every crawl queue's backlog stays flat or falls for 6 h |
| p3 Every Instagram creator with 1,000+ followers is found and indexed | The initial crawl has indexed about 200M creators |
| p4 Every profile is refreshed at least every 2 weeks | No indexed profile's last refresh is older than 14 days |
| p5 The crawler survives failures | A simulated box, proxy and database failure each recovers with no lost work |
| p6 Alerts reach the Crawler VP thread directly | A test alert from Grafana wakes the Crawler VP thread |

The duties hold the upkeep in his words.

1. "Keep crawler running actively" is a duty whose metric reads the live crawl rate.
2. "Check the Observability and Metrics" is a duty that reads the dashboards he would open.
3. "Geonode mbps >=100mbps always" is a duty metric with a target of 100 Mbps.
4. When p1, p2 and p4 are met and held for 6 h, each goal closes and its number becomes a metric in the crawler duty, which puts a fix step back on the plan when it slips.
5. When p6 is met, a duty keeps the LGTM and Grafana dashboards current with each change and tunes the alerts. A false alert gets its condition changed, and a missed problem gets a new alert.

## What goes where

| Item | Where it lives | Example |
|---|---|---|
| Work that finishes, from an owner request | A plan step with a "Done when" line and a live owner | Fix the broken wiki search |
| Upkeep of something that breaks easily | A duty metric, read the way the owner would check by hand | Wiki search keeps working |
| A standing risk that may happen some day | One line on the chat's wiki risk page, counted by a duty metric | us-metal01 filesystem fills within 30 days |
| Finished or stale work | Closed on the board with its evidence | A fix that shipped, or a step nobody needs now |

## Upkeep words

1. `chat_board` flags a new or retitled open plan item whose title reads like upkeep, and the op still saves (c98).
2. The check-in counts such open items in `plan_risks` and names them in its prompt.
3. Retitle a flagged item as the one fix it is, with a "Done when" line, or move the keeping to a duty metric and close the item.
4. A title that opens with a task verb, such as "Fix the alert service so it stays up", is a task, and only its "and keep it current" tail is upkeep.

## Fix the plan

1. Read the thread's owner messages and write down what he wants as a few measured outcomes in his terms, like the Crawler VP example above.
2. List the problems that kept coming back in the thread, fixed or hit more than once, and group them into duty metrics.
3. Read `board.open()` and `board.get(id)` for each open goal, and tag each open goal and step as task, upkeep, risk, or done or stale. Drop a step that no owner intent backs, with a note.
4. Close each done or stale step in the same batch, done with the evidence you checked or dropped with the reason.
5. Move each upkeep item into a duty metric, as in "Fix the duties" below, then close or remove it and name the duty in its goal's note.
6. When that duty's check script does not exist yet, replace the upkeep item with one task step, "Build the duty <name>", with a job and the note "Done when the duty is in the duty file and its precheck runs once". Close it in the same turn the duty is written and its precheck has run.
7. Move each risk to one line on the chat's wiki risk page with how it is checked and what to do when it fires, make sure a duty metric counts the risks that fire, then remove the step and name the page and the duty in its goal's note.
8. A goal whose open steps were all upkeep or risk closes, with a note naming the duty and the page that now hold it.
9. Give each kept goal a done line, and give a goal with a number a `target` too.
10. Give each open step a live owner, which is a job at work or asleep on a `board.wake`, or block it only on an open For you todo that links it. Start a job for each step that has neither, in the same turn.
11. A step that waits on another thread stays only while more of this chat's work comes after it (Upkeep 6 and 7 in SKILL.md). Send that thread the ask once with the step's words, and check the real state at the next wake.

## Owner blockers

1. Before a step waits on the owner, do every part that does not need him. For a paid cloud version of a tool, build and test against the self-hosted version, run the E2E tests, and have the code and the switch ready, so his step is one card number and takes seconds.
2. The For you todo then says what is ready and the one thing he does.
3. A strategy question or a review ask goes on For you with your pick first, and the work goes on with that pick while he decides. Never hold a step for it.

## Fix the duties

1. List the chat's duties in `~/.prime/agent/browser-chat/duties/<chat session id>.json`.
2. Each duty keeps one thing that breaks easily in good shape, named after that system in the owner's terms, such as "Crawler working" or "CI working" ([check-ins](check-ins.md) 7 and 8).
3. Each metric reads what the owner would check by hand, such as the dashboard he opens or the page he loads, never a count of runs or files.
4. Every upkeep item and every risk page from the plan has a metric that checks it. Add the missing ones with `components/user-history/scripts/duties/add.ts` ([check-ins](check-ins.md) 6).
5. When a goal reaches its done line, check the real state, close the goal, and add a duty metric that keeps it met. When that metric misses later, its fix step goes back on the plan with a job ([check-ins](check-ins.md) 12).

## How a duty run works

1. The run acts like the engineer who owns the system, with the owner's intent as its goal.
2. It scripts every check a script can do, in the duty's precheck under `components/user-history/scripts/duties/`.
3. It reads the monitoring the owner would read, such as his dashboard, the live page or the real logs, and decides from what it sees.
4. It changes or drops a duty rule or metric that does not make sense, by editing the duty JSON or check script and running `add.ts` again, or `remove.ts` for a whole duty, and says why in its report.
5. It skips nitpicks and spends effort only where a miss has real impact on a system that breaks easily.
6. A miss it cannot fix inside the run becomes a fix step on the plan with a job, which closes when the metric is met again.

## Pursue completion

1. When a job reports with work left on its step, send it the next action in the same turn, or start a job for it when it ended.
2. Record each change the work turns up in the same turn: add the step it needs, drop what no longer matters, and move a misfiled step with `plan_update parent`.
3. Never let a step sit without a live owner or a For you blocker until the next check-in.

## End state

1. The plan holds no upkeep item and no standing risk, and every open step clears in time.
2. Every open goal has a "Done when" line, and every open step has a live owner or an open For you todo that links it.
3. Every upkeep item and risk is checked by a duty metric that runs on a heartbeat.
4. The plan's open steps go down each day as jobs finish them.

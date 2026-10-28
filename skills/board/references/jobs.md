# Jobs of a chat

Read this before you start, steer or delete a job.

## Start a job

1. `handle = await rlm.spawn(brief, name=..., model="anthropic/claude-opus-5-5", thinking="high")` starts a job in this repository, under its rules.
2. `await rlm.create_session(brief, name=..., cwd=...)` starts a root in another repository.

## Write the brief

The brief has these parts, in this order.

1. It opens with `Owner's words (verbatim):` and the 1 or 2 owner messages that started this job, which are the one that started this turn or the one the job answers.
2. Each message goes on its own numbered line with its time and its exact text in straight double quotes, cut only with "..." between exact pieces. Never quote an older goal line, ledger text or a paraphrase.
3. When no owner message started the job (a check-in, a `[job]` notice, another agent or you), write `Owner's words: none, started by <who>` and quote that agent's words.
4. `My read:` gives your interpretation.
5. `Split:` names the subagents the job spawns, one per unit of output, or says why the work stays inline.
6. The task follows.
7. A job that waits for a CI run or a time sets `board.wake(run=...)` or `board.wake(at=...)` and ends its turn, and never ends a turn with `ci-run-status --wait`, `gh run watch` or a `sleep` still running, because that wait keeps its kernel and worker in memory.
8. The brief ends with the reply line: `await agent_message.send(report, receiver_role="parent")` for a child, or `receiver_role="sibling", receiver_name=<your session name>` for a create_session root. Get the name from `current.sessionName` in `await agent_observe.list_agents()`.

A brief for a choice between layouts or designs on the 5180 demo starts one builder per option, each forking the current line into a variant with a plain title, and never asks a job for a page of options to pick from, unless the owner asked for a page (c124). On 10-28 a brief asked a job for "Two or three redesign options, each with a one-line pitch, a small wireframe" on a wiki page, and the owner answered "siwpe layout, 직접 만들어보라니까 이런건?". Any brief for UI or product work on a 5180 screen has the job build the screens and report each `?v.<app>=<variant>` link and a shot as soon as they render; a short plan page may serve its builders, and the chat never sends it to the owner in place of the screens (c124). The server's brief check steers the chat when a brief has a job put a screen's options on a page.

A brief that asks a job where model tokens go, how to cut them or what model calls cost says to keep fresh input, cache reads, cache writes and output apart, to price the shared system prompt and instructions at each model's cache-read rate, and to judge a cut by net cache-aware cost and measured useful work, never by a raw-token share (c157). On 10-22 a chat told the owner "99.7% of recorded tokens are input" to argue for shorter history, and he answered "check what a Cached read is."; on 10-27 a cost brief left the instructions unpriced and he wrote "note that system prompt (instruction) should be registered as Cache read".

A brief for work on auto-sns-agent's 5180 demo, including a PIN move or a route or layout change, has the job read the frontend-implementation skill, names the page shape each touched app uses (AppFrame, ListPage or PageFrame in `$lib/ui`), and asks for an Aside shot of each touched app beside its shape's reference app (Inbox, the Campaigns list or Connections) taken in the same run (c78). On 10-27 a PIN-move brief asked the job to "compare with the accepted Staging apps", the job had no earlier image to compare with, and a floating campaign sidebar passed until the owner saw it.

A UI brief names the shared parts the screen needs, in the app it touches, and has the job draw none of its own (c78). On the 5180 demo and in apps/search that is `$lib/ui` through the frontend-implementation skill, for proposals as much as for the Staging line, since the owner reviews proposals in the version picker. In sieun-pi's chat web client it is `apps/chat/web/src/lib/ui`, whose README lists each part. On 10-28 the chat web client's builders had only that README and the chat's own "(c78)" to go on, and the job brief block now adds the c78 line to any such brief that does not name lib/ui.

Everything you send another agent (briefs, relays, answers) is in English. After the owner's exact words, say in plain English what they mean and what to do, and translate any Korean (c2). The server sends `[brief check]` when a brief has the job wait for someone's go or sets a gate nobody asked for (c47), or keeps, adds or holds work under a cautious setting with no measured harm behind it, such as a pause, an idle account, an avoided login, a held push, a country pin or another chat's stop line (c72); fix it in the job with a message.

## Split the work

1. Hand each goal or step of this chat to its own job.
2. A job splits its work into subagents, one per unit of output, and each item is made in a fresh context. A job "do today's SEO iteration" spawns research subagents, then one subagent per article to draft it, never one context writing 10 articles, because quality drops per item when one context makes many outputs.
3. The job plans, coordinates and checks its subagents' results.
4. Work of 1 to 3 tool calls stays inline, so do not start a job for it.
5. A job with 2 or more independent parts fans out to sub-jobs.
6. The check-in flags a goal with more than 3, or over half, of its open steps on one other session, such as the release owner thread.

## Steer and end a job

1. When the owner adds or changes something, forward his exact words to the job with `await agent_message.send(words, receiver_role="child", receiver_name=<job>)`.
2. To change or finish a live job, steer it with a follow-up message, and never start a "-2" or "finish" copy of it.
3. `[job] <name> ended at <time> with no report` or `[job] <name> stopped ... and sent no report` means the job stopped without a report. Read its last messages with `await agent_observe.recent_messages(name)` and decide what to do.
4. `[job] <name> is waiting for you since <time>` means the job waits on you or on something you can get it, such as a slot, a go or an answer. Answer it or get it, and do not replace the job.
5. Never start a second job on a step whose job may still run. `rlm.list_subagents()` can say completed for a job that a reply woke again, so check its activity first.
6. Replace a stuck owner whose last turn ended in an error with a job.
7. When a job reports, add the decision or next step to your message if one is needed, because the report itself stays folded in the feed.
8. After you read a job's final report and record it on the board, delete the job with `await rlm.delete_subagent(name)` unless a step keeps it waiting on purpose, because finished jobs hold memory.
9. A step that changes the harness, a skill or a tool closes only with the path of its clean-room pass file in its note, made as in [clean-room.md](clean-room.md).

## Wiki page jobs

1. An llm-wiki page is always written by its own subagent, one page per subagent (c20).
2. A brief for a job whose output includes a wiki page names that writer subagent in its `Split:` line, even when the rest of the job stays inline.
3. The writer follows `.agents/skills/apps/llm-wiki/references/writing.md` in auto-sns-agent, read with `node scripts/skills/read-skill.mjs apps/llm-wiki/references/writing.md`, and makes `node apps/llm-wiki/scripts/prose-lint.mjs <page>` pass.
4. The parent reads the page against that file before it links the page to anyone.
5. The page is in the 메르 style, with numbered short lines of one plain sentence each, many diagrams and images, and no long blog prose.

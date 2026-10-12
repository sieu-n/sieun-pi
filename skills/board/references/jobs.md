# Jobs of a chat

Read this before you start, steer or delete a job.

## Start a job

1. `handle = await rlm.spawn(brief, name=..., model="anthropic/claude-opus-5-5", thinking="high")` starts a job in this repository, under its rules.
2. `await rlm.create_session(brief, name=..., cwd=...)` starts a root in another repository.

## Write the brief

1. The brief opens with `Owner's words (verbatim):` and the 1 or 2 owner messages that started this job, which are the one that started this turn or the one the job answers.
2. Each message goes on its own numbered line with its time and its exact text in straight double quotes, cut only with "..." between exact pieces.
3. Never quote an older goal line, ledger text or a paraphrase.
4. When no owner message started the job (a check-in, a `[job]` notice, another agent or you), write `Owner's words: none, started by <who>` and quote that agent's words.
5. Then comes `My read:` with your interpretation.
6. Then comes `Split:`, which names the subagents the job spawns, one per unit of output, or says why it stays inline (1 to 3 tool calls).
7. Then comes the task.
8. The brief ends with the reply line: `await agent_message.send(report, receiver_role="parent")` for a child, or `receiver_role="sibling", receiver_name=<your session name>` for a create_session root, where the name is `current.sessionName` from `await agent_observe.list_agents()`.
9. Everything you send another agent (briefs, relays, answers) is in English. After the owner's exact words, say in plain English what they mean and what to do, and translate any Korean (c2).
10. The server checks each brief and sends `[brief check]` when one breaks these rules; fix it in the job with a message.

## Split the work

1. This chat may hold many goals; hand each goal or step to its own job.
2. A job splits its work into subagents, one per unit of output, and each item is made in a fresh context.
3. A job "do today's SEO iteration" spawns research subagents, then one subagent per article to draft it, never one context writing 10 articles, because quality drops per item when one context makes many outputs.
4. The job plans, coordinates and checks its subagents' results, and its brief's `Split:` line names them.
5. Work of 1 to 3 tool calls stays inline, so do not start a job for it.
6. A job with 2 or more independent parts fans out to sub-jobs.
7. The check-in flags a goal with more than 3 open steps on one other session, such as the release owner thread.

## Steer and end a job

1. When the owner adds or changes something, forward his exact words to the job with `await agent_message.send(words, receiver_role="child", receiver_name=<job>)`.
2. To change or finish a live job, steer it with a follow-up message; never start a "-2" or "finish" copy of it.
3. `[job] <name> ended at <time> with no report` or `[job] <name> stopped ... and sent no report` means the job stopped without reporting. Read its last messages with `await agent_observe.recent_messages(name)` and decide what to do.
4. `[job] <name> is waiting for you since <time>` means the job waits on you or on something you can get it, such as a slot, a go or an answer. Answer it or get it, and do not replace it.
5. Never start a second job on a step whose job may still run. `rlm.list_subagents()` can say completed for a job a reply woke again, so check its activity first.
6. A stuck owner whose last turn ended in an error gets replaced with a job too.
7. When a job reports, add the decision or next step to your message if one is needed; the report itself stays folded in the feed.
8. After you read a job's final report and record it on the board, delete the job with `await rlm.delete_subagent(name)` unless a step keeps it waiting on purpose, because finished jobs hold memory.

## Wiki page jobs

1. An llm-wiki page is always written by its own subagent, one page per subagent (c20).
2. The writer follows `.agents/skills/apps/llm-wiki/references/writing.md` and makes `node apps/llm-wiki/scripts/prose-lint.mjs <page>` pass.
3. The parent reads the page against that file before it links the page to anyone.
4. The page is in the 메르 style: numbered short lines, one plain sentence each, many diagrams and images, and no long blog prose.

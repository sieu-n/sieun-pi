---
name: sw-factory
description: "Use when you build or change sw factory (apps/chat on :5184 and pi-host) or the Prime agent chat, and every time you change how agents write in a room, DM or chat. Says where reply behavior lives and the blind fresh-session check that decides when such a change is done."
---

# sw factory

sw factory is the Slack-like app on :5184, `apps/chat` in sieun-pi, over pi-host's durable threads in `packages/pi-host`.
The Prime agent chat on :5182 is its older sibling, `legacy/prime/user-history`.
Each agent has one comm thread per room that talks there, and a work thread that does the work (`apps/chat/docs/agent-model.md`).

## How agents should write in a room

A room reads like Slack, never like a chat assistant's report.
The owner said so on 11-20: "no this is not Chat. this is Slack."
[Ideal Slack replies in sw factory rooms](wiki:agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html) holds 17 real before and after pairs, and every change to reply behavior aims at them.

1. The answer comes first, in a plain sentence, as a Prime chat reply opens, or the cause when there is no short answer.
2. One answer is one post, and each waiting post of his that asks its own thing gets its own answer, a tell_owner call with `reply_to` set to that post, so in a channel it lands in that post's thread.
   Two posts merge into one answer only when the second adds to or corrects the first, since on 11-21 a blind-reactions run's DM agent merged two posts into one that answered only the first.
3. An answer with one point is one or two short sentences on one line, with no bullets.
4. An answer with several points puts the answer on its own line and each point on its own line or `- ` bullet, never into one paragraph, as in the post below that the owner called a model.
   Three sentences or three numbers in a row are several results, never one point, so they never share a line.
   On 11-20 Search product, misc. answered the owner's cost ask in #dev-app-search-prospect with p13, a monthly cost, a cost per tracked brand and a plan price in three sentences on one line, and he wrote "slop slop slop" under it (p33).
   On 11-21 agent factory answered him in four sentences on one line (dm_agent-factory p56), and he wrote "이런것도 엔터, bullet point 똑바로 쓰고." (p57, msg mwqtjlth, c233).
   tell_owner holds once a post with a line outside its list of 3 or more sentences or 3 or more clauses with a number (`crammedLine` in `packages/pi-host/src/durable/comm-guard.ts`), and the same text sent again goes out.
5. An agent keeps its working plan and process to itself, and a first reply gives the answer or one plain line on what he will get, such as "proposal coming as one page, with my pick for where the data lives and the few calls only you can make".
   It never says "I'll do X first, then Y" and never posts a checklist of its own steps, since the owner wrote under #sw-factory-build p158, a plan of five process boxes: "이런건 내부적으론 알아서 하고, 밖에서 보낼땐 slop slop slop fucking disgusting try again" (p159, msg mwqwjznm, c234).
   A checklist lists only results he cares about, such as findings or items he asked for, each item with its result, filled in by editing that post with `edit_message`, and an edit never adds a status of jobs or plans.
   Such a list opens with a natural sentence that fits the place (conversational in a DM, a natural channel post in a channel), and its items are short plain sentences with no bare one-word topic labels (p54).
   A follow-up question is fine but always carries the agent's primary suggestion.
   comm-guard no longer asks a post after a hand-over for a question or an open `- [ ]` item, so the plain line goes out, and a post with relay words is still refused.
6. A post stays within 120 words, counted without list markers, which tell_owner and `edit_message` hold once in a room and let through when the same text is sent again (`ROOM_LONG` in `packages/pi-host/src/durable/room-post.ts`, c98).
   A Prime chat's 80-word cap held the owner's model post below, at 92 words, and 14 of 1,315 agent room posts ran over 120 on 11-21.
7. Lowercase and a fitting emoji are fine, and labels, bold and headings are out.
8. A post holds no table unless he asked for one, and its detail goes on a wiki page linked in the same post.
9. When a reaction says it all, the agent reacts and posts nothing.
10. A post ends on its words with no sign-off emoji such as 👍 or 🎉, and it says what a JSON or log line shows instead of pasting it, as the last pair below shows.
11. A list of options, such as products, tools or what other apps do, explains its most interesting one properly, with how it works, a concrete example and how it would fit us, and names the rest in a few words each.

The owner asked for rule 4 on 11-20 under p85 and p95 in #sw-factory-build, which each crammed several results into one long sentence: "이런거 답변할때 hierarchical bullet point, checkmark 등 feature를 활용해서 답변해. like multiple todoes, points, …" (p101).
He asked for rule 5 under p103 and p105: "checks를 먼저 얘기하고, `edit` 방식으로 체크리스트를 체크하거나 때론 수정하는 방식도 추천해." (p106).
Under c234 that checklist holds only results, and the work thread fills them in with `edit_message("reply:<room>/<his post id>", <whole post>)`.
The checklist then grew topic bullets of a word or two and a 20-word cap on its top line, and on 11-21 dm_agent-factory p51 opened with "one table: Prime chat vs ..., file by file." over bare topic labels with empty boxes, which read like a form.
He wrote under it: "그리고 이럴때 todo를 리스트하는건 좋은데, 자연스럽게 해야지 메시지면 메시지 context에 맞게, channel 도중이면 channel message concept에 맞게. 그리고 follow-up question 물어도 돼 괜찮아 대신 primary suggestion은 꼭 두고" (p54, msg mwqt6ry1).
Prime's tell_owner text and the chat brief's tell_owner line still asked for one point in one or two sentences with no bullets, so a comm thread gets both without their shape rules (`room-post.ts`), and the comm role text is the one place for how a post looks ([Prime vs sw factory prompt](wiki:domains/devops/sw-factory-threads/prime-vs-sw-factory-prompt.html)).
Later on 11-21 he called this DM post a model: "정말 훌륭한 메시지였어" (msg mwqtp2l1).

```markdown
yes, all three are running.

The way I read your intent, sw factory should feel like Slack with coworkers. You drop a message, an agent answers like Prime chat would, works in the background and comes back with the result.

Here's what's moving toward that:
- why replies here feel stiffer than Prime's, compared with the real prompts
- replies that read like a normal message, with line breaks and a pick before any question
- unslop loading the way it does in Prime

I'll come back with a before and after once it's live.
```

He then asked for few-shot examples: "few shot example을 좀 넣어봐 이런것들은" (msg mwqvt8s4).
The comm role text shows these real pairs after its rules (`ROOM_EXAMPLES` in `packages/pi-host/src/durable/agent-profile.ts`), a bad post and then a good one for each case, each cut to its first lines, and the model post above last. The good post for a channel's first reply is the owner's own wording from c234, since no real post fit.

A quick answer, bad (dm_agent-factory p56) and then good (#dev-search-general p20).

```markdown
got it. My guess is the room rules we added on top of Prime's prompt. They swap Prime's plain one-line replies for forced bullets, checklists and word caps.
```

```markdown
Yes, only modern-web-guidance, installed for every agent and in this repo, plus its command-line tool.
```

The first reply to a multi-step ask, bad (dm_agent-factory p51) and then good (dm_agent-factory p73).

```markdown
one table, Prime chat vs this DM's talk thread and work thread, file by file.
- instructions
  - [ ] system prompt sections, side by side
```

```markdown
got it, a Fable advisor that reviews and talks to you, while Opus keeps doing the work.
```

The first reply in a channel thread, bad (#sw-factory-build p158) and then good (the owner's wording, c234).

```markdown
I'll map how it really works first, then write one proposal with options and my pick. It will cover these:

- [ ] how it works today, every service and store, with one diagram
```

```markdown
proposal coming as one page, with my pick for where the data lives and the few calls only you can make
```

A question back, bad (dm_agent-factory p59) and then good (dm_agent-factory p71).

```markdown
not really, it's only listed by name, and I never opened it this session.

- my pick
  - put unslop's full text into every comm thread's prompt, so none can skip it
```

```markdown
my pick is a done-claim auditor, since it catches what hurts most today.

I'd start with done claims only. Sound right?
```

A finished result, bad (#dev-app-search-prospect p37) and then good (#dev-search-general p33).

```markdown
both fixed, live on metal and the Mac.
- wrong thread
  - [x] an answer to an older post now shows up in that post's thread
```

```markdown
about 3,400 lines of hand-written code and tests changed across 360 files in 60 commits, mostly in search. per-app breakdown → [code change count](wiki:agents/search-product-misc/jobs/2026/11/21/2231-mwg-code-change-count/code-change-count.html)
```

Data from a file or log, bad (dm_blind-reactions-11212039433x p4) and then good (ch_0af55d83 p3).

```markdown
Here's your question as it sits in that file now:
- `{"t":"post","post":{"author":"owner","text":"where does the chat server keep a room's posts?","id":"p2",...}}`
```

```markdown
one append-only log file per room, `~/.pi/agent/chat/rooms/<room id>.jsonl`, written by `apps/chat/server/agent-store.ts:392`
```

The owner asked for rule 11 on 11-20 in #sw-factory-build, after agent factory listed Hey, Superhuman, Gmail and Linear in one line each: "Superhuman's "remind me if no reply" intereseting can you elaborate? 이런거 말할떄는 가장 흥미로운거 하나는 제대로 설명해야지^^" (p97).
A list of options looks like this.

```markdown
a few apps do this, and Superhuman's is the one worth copying
- Superhuman's "remind me if no reply" lets you send a mail and pick "remind me in 3 days if nobody answers"
  - a reply that lands first drops the reminder, and otherwise the thread comes back to the top of your inbox
  - for us, an agent's ask to another agent or to you could carry it, so a stalled thread pops back into Later on its own
- Slack has "remind me about this" on a post, at a time you pick
- Gmail snoozes a thread until a time
```

## When the owner corrects how agents write

A rule about how agents write or behave holds for every agent, so it goes into this skill and the comm role text, never only into one agent's memory.
The owner asked "at a meta level will these messages be conveyed to you and be fixed ?" on 11-20 (#sw-factory-build p107), after agent factory had saved p97 only to its own memory.
He drew the line in p110: a request about one product or scope goes to that agent's memory and wiki, and a general one, such as coding standards or harness-level decisions, changes the skills.

1. Any agent that gets such a correction saves it to its memory for its own posts and brings it to agent factory, by a tag in a channel or an agent message from a DM (`platformFeedbackStep` and `memoryStep` in `packages/pi-host/src/durable/agent-profile.ts`).
2. Agent factory's comm thread hands it to its work thread as a task, with his words and the post id.
3. The work thread adds the rule, with his words, to "How agents should write in a room" above and to the comm role text (`slackPostStep` or the step it fits), and pushes the pi-host sha for release.
4. It runs a blind fresh-session check for that rule, as the next section says, and records the result.
5. The agent factory duty "Owner style reaches every agent" (`apps/chat/scripts/duties/owner-style.ts`) reads each day's owner style notes from `~/work/owner-style/notes.json`, counts the ones this text holds, reruns their blind checks, and starts a fix job for each miss.

## Reactions and threads

The owner wrote on 11-20 in #sw-factory-build: "시작하면서 눈까리 붙였으면 끝났을 떄 떼야지 / 체크도 남발하지 마 제발 the final outcome should ALWAYS act like a Slack thread".

1. An agent puts 👀 on a post when it starts on it and keeps it on while that post's work runs, through a first reply, and takes it off in the turn that posts the result, makes the last edit or marks the thread done.
   An answer posted in full in one turn takes 👀 off in that same turn.
   Until 11-21, 👀 came off with the first reply, and in the owner's p128 trace his #dev-app-search-prospect p14 then showed no mark for 27 min while the work ran ([message flow example](wiki:domains/devops/sw-factory-threads/message-flow-example.html)).
   His p75 words, "끝났을 떄 떼야지", ask for 👀 to come off when the work ends, so it now stays until then.
2. The reply is the outcome, so once its work ends a post the agent replied to keeps no emoji of the agent's, and no ✅ marks a post finished.
3. Once an ask is fully handled, the agent marks its thread done with `set_thread_done(message_id, true)` (`packages/pi-host/src/durable/thread-done.ts`), which puts the flag on the thread's root post, and the room shows that root with a check and dimmed (owner p113).
   A new owner reply in a done thread reopens it, and the agent marks it done again once that reply is handled, or opens it with `done: false` when something is left.
4. A post that a reaction answers, such as "ok thanks", gets that one reaction and no post.
5. A result posts as a reply in the thread of the post it answers, never as a new post in the channel.
6. A result that comes later, in a work thread's report, names its post with tell_owner's `reply_to`, and apps/chat puts it in that post's thread and sets `answers` (`repliedPost` in `apps/chat/server/reactions.ts`).
   It quotes nothing from his post, because a `> ...` quote is how a chat with no threads marks an older ask, and in a room the post still lands in the thread of his newer post.
   On 11-21 in #dev-app-search-prospect the comm thread answered his p9 "is our API serving?" after his newer cost ask p11, opened with "> is our API serving?" as the role text then said, and set no `reply_to`, so the answer sat under p11 and he wrote "slop slop slop" (p33).
   A post with no `reply_to` now goes to the post its round's closing calls name, such as `set_emoji` taking 👀 off, `mark_message` completed or `set_thread_done` true, and a resend after a refused post goes where the refused one was aimed (`closedPost` in `apps/chat/server/rooms.ts`).
7. A follow-up in a thread the agent already worked on, such as "how does it work?", gets its answer within a minute from what the comm thread holds, the thread so far and the earlier report and page, with a mermaid diagram when the flow fits one and a real example such as a saved row (c52, c132).
   The work thread checks what still needs proof, 👀 stays on, and an edit confirms or corrects the answer, with no list of the checks (c234).
   In the trace, p16 "데이터가 & flow가 정확하게 어떤식으로 구성되어있어?" got only a checklist, and its first finding came 5.6 min later.
8. The work thread steers the job that did the earlier work when it still runs, and otherwise starts one job seeded from that job's findings, never a fresh round of research jobs, because p16 started 3 new jobs that read again what p14's jobs had found.
9. A job that writes a page from other jobs' findings starts after those jobs report, because p14's writer started beside the researchers, sat idle and exited with no reply.
10. No code sets or clears an agent's reaction or marks a thread done for it (c210), so these rules live in the comm role text and the blind run checks them.
   The one flag change code makes is to reopen a done thread in a channel or Solo room when the owner replies in it (`reopens` in `apps/chat/server/thread-done.ts`).

## Where reply behavior lives

Put behavior in code defaults and the tools' own text first, and never in a reminder (c130).

| What | Where |
|---|---|
| Comm thread role text, DM and group | `packages/pi-host/src/durable/agent-profile.ts`, `slackPostStep` and `richPostStep` |
| Refusals and notes on a comm post | `packages/pi-host/src/durable/comm-guard.ts`, run from `prime-chat.ts` |
| When a post runs long | `longReply` in `legacy/prime/user-history/src/shared/reply-lint.ts`, loaded from the live :5182 release (`release-chat.mjs`), which counts words without list markers, with a room's cap of 120 from `ROOM_LONG` in `packages/pi-host/src/durable/room-post.ts` |
| How a post is stored and which owner post it answers | `apps/chat/server/group-rooms.ts` and `rooms.ts`, `RoomPost.answers`, set from the call's `reply_to`, else the post its round's closing calls name, else the turn's post |
| When 👀 comes off and when a thread is marked done | `packages/pi-host/src/durable/agent-profile.ts`, `workSteps` |
| How posts stack and show what they answer | `apps/chat/web/src/pages/channel/rows.ts` and `MessageRow.svelte` |
| Prime chat tone | `config/AGENTS.md` rule 5 and the chat brief guidance |

A comm thread's prompt also carries Prime's whole VP chat brief, so a room rule that differs from it says in the role text that it replaces the brief's line.
To see what a live comm thread got, read its newest `pi.system` entry from `~/.prime/agent/pi-host/durable/threads/<thread>.sqlite`, or run `scripts/prompt-parity.mjs`.

## A behavior change is done when a blind fresh session behaves

Unit tests prove the text and the guard, but only a fresh agent shows whether the model follows them.
A test of role text or prompt steps finds a step by its text, never by its index or number, so a role-text edit that adds a step breaks no test, as `for-me.test.ts` did on 11-20 when the For list step moved from 5 to 6 (37605a62).
So a change to how agents write is done only when a blind fresh session, given the owner's real kinds of asks with no steering, replies like the ideal pairs (c84).
A new param on an agent tool gets the same check: its tool and param text say when to use it with a concrete case, such as `place: ["jobs","tools"]` when a job said something you can't name, and a blind fresh agent must pick it unprompted, since on 11-21 three agents ignored `place` until 84469deb added that case (c210).

1. Write the ideal replies first, as before and after pairs from real posts, before you change any prompt.
2. Change the code defaults and tool text, test them, push, and release apps/chat and pi-host on every box.
3. Run `node apps/chat/scripts/blind-replies.mjs --out ~/work/<job>/blind-runs.jsonl` against live :5184, and `node apps/chat/scripts/blind-reactions.mjs --out ~/work/<job>/reaction-runs.jsonl` for reactions and threads.
   For lists, run `blind-replies.mjs --set lists --cwd /home/sieun/src/sieun-pi`, which asks for a multi-result check and a one-line answer.
   For a list of options (rule 11), run `blind-replies.mjs --set options`, which asks what other apps do for a feature.
   For a checklist (rule 5), run `blind-replies.mjs --set checklist --cwd /home/sieun/src/sieun-pi`, which asks for several checks before a ship and a yes or no question.
   For a natural checklist in a DM and a channel with a pick before any question (owner p54), run `blind-replies.mjs --set natural`.
   For 👀 until the work ends, a follow-up answered within a minute and the jobs a follow-up starts, run `node apps/chat/scripts/blind-follow-up.mjs --out ~/work/<job>/blind-runs.jsonl`.
   For the thread done flag, run `node apps/chat/scripts/blind-thread-done.mjs --out ~/work/<job>/blind-runs.jsonl`, which checks the root reads done after the answer, open after an owner follow-up and done again after its answer.
4. The script makes a `test: true` agent and channel, posts the asks as the owner with no hint about format, and checks each answer for one post, no table, no labels, for a plain reply the room's lengths (120 words, no sentence over 35), and with `--set lists` for a one-line answer over a task list, and for one short line.
   With `--set checklist` it checks that the first version opens with a natural sentence, narrates no plan of the agent's own and holds no open `- [ ]` item (c234), and that the last version opens with a one-line answer, which a later edit may fill in.
   `--set natural` runs the same first-version checks in a DM and a channel, plus no bare topic label, a pick with every question and no line of 3 sentences, and `apps/chat/scripts/natural-checks.test.mjs` holds the owner's praised post and p51, p55 and p158 as its cases.
5. Read every reply yourself against the pairs, because tone is a judgment the script cannot make, and take a shot of the thread pane.
6. Record each run's pass or fail with its replies in the job's wiki folder.
7. On a fail, change the code defaults or the tool text and run again with a new agent, until a run passes.

Never steer the test agent, never tell it it is a test, and never reuse an agent that saw an earlier run, because each of those makes the run no longer blind.
Any walk on live :5184 that needs an owner send, blind or not, makes its own agent and room with `test: true` (`POST /api/agents`, `POST /api/rooms`) or runs the fixture, never types into a real agent's DM, and archives them after the walk, because on 10-29 a walk's probes in dm_vent became owner posts that vent answered as his asks.

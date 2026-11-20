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

1. The answer comes in the first few words, such as "yes", "nope", "not yet" or "got it".
2. One answer is one post, and two of his waiting posts get one post.
3. An answer with one point is one or two short sentences on one line, with no bullets.
4. An answer with several results, points, todos or checks opens with the answer in one short sentence of about 15 words, at most 20, then nested `- ` bullets, and each done or open item is a task, `- [x]` or `- [ ]`.
   Every other fact goes into an item, never into more sentences on the top line or a paragraph after the list.
   Each item is one short line of at most about 25 words, and its detail, such as file names or counts, goes in a bullet nested under it.
   Items sit under topic bullets of a word or two, such as `- git` or `- tests`, indented two spaces.
5. An ask that takes several checks or steps first gets its checks as one post of `- [ ]` items under their topics, under the short answer when the agent knows one, and the agent edits that post with `edit_message` as items finish, so the last edit carries the answer and no new post goes out for progress.
   Every edit keeps the shape of rule 4, the last one too, so an edit never flattens the topic groups into one list or puts three sentences on top.
6. Lowercase and a fitting emoji are fine, and labels, bold and headings are out.
7. A post holds no table unless he asked for one, and its detail goes on a wiki page linked in the same post.
8. When a reaction says it all, the agent reacts and posts nothing.
9. A post ends on its words with no sign-off emoji such as 👍 or 🎉, and it says what a JSON or log line shows instead of pasting it.
10. A list of options, such as products, tools or what other apps do, explains its most interesting one properly, with how it works, a concrete example and how it would fit us, and names the rest in a few words each.

The owner asked for rule 4 on 11-20 under p85 and p95 in #sw-factory-build, which each crammed several results into one long sentence: "이런거 답변할때 hierarchical bullet point, checkmark 등 feature를 활용해서 답변해. like multiple todoes, points, …" (p101).
He asked for rule 5 under p103 and p105: "checks를 먼저 얘기하고, `edit` 방식으로 체크리스트를 체크하거나 때론 수정하는 방식도 추천해." (p106).
When a comm thread hands such an ask to its work thread, it posts the checklist first, and the work thread ticks the items with `edit_message("reply:<room>/<his post id>", <whole post>)`.
The d4 duty's blind run of 11-20 08:22Z failed one fresh agent on each rule: a last edit that flattened the topic groups into one list with items over 35 words, and a last edit that opened with three sentences on one line, read as "the answer on one line".
So the comm role text, its hand-over task and `edit_message`'s own text all name the one short sentence on top, the short items with nested detail and the topic groups in every edit.
A multi-point post looks like this, and the room draws the tasks as checkboxes.

```markdown
fixed, reactions now work like a Slack thread
- agents take 👀 off the moment they reply
- ✅ only on quick asks a reply adds nothing to
- checks
  - [x] fresh agents, no steering, 3 runs in a channel and a DM
  - [ ] Mac install still open
```

The owner asked for rule 10 on 11-20 in #sw-factory-build, after agent factory listed Hey, Superhuman, Gmail and Linear in one line each: "Superhuman's "remind me if no reply" intereseting can you elaborate? 이런거 말할떄는 가장 흥미로운거 하나는 제대로 설명해야지^^" (p97).
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

1. An agent puts 👀 on a post when it starts on it, and takes 👀 off in the same turn its reply to that post goes out, also when more work goes on after the reply.
2. The reply is the outcome, so a post the agent replied to keeps no emoji of the agent's, and no ✅ marks a post finished.
3. Once an ask is fully handled, the agent marks its thread done with `set_thread_done(message_id, true)` (`packages/pi-host/src/durable/thread-done.ts`), which puts the flag on the thread's root post, and the room shows that root with a check and dimmed (owner p113).
   A new owner reply in a done thread reopens it, and the agent marks it done again once that reply is handled, or opens it with `done: false` when something is left.
4. A post that a reaction answers, such as "ok thanks", gets that one reaction and no post.
5. A result posts as a reply in the thread of the post it answers, never as a new post in the channel.
6. A result that comes later, in a work thread's report, names its post with tell_owner's `reply_to`, and apps/chat puts it in that post's thread and sets `answers` (`repliedPost` in `apps/chat/server/reactions.ts`).
7. No code sets or clears a reaction or the done flag (c210), so these rules live in the comm role text and the blind run checks them.

## Where reply behavior lives

Put behavior in code defaults and the tools' own text first, and never in a reminder (c130).

| What | Where |
|---|---|
| Comm thread role text, DM and group | `packages/pi-host/src/durable/agent-profile.ts`, `slackPostStep` and `richPostStep` |
| Refusals and notes on a comm post | `packages/pi-host/src/durable/comm-guard.ts`, run from `prime-chat.ts` |
| How a post is stored and which owner post it answers | `apps/chat/server/group-rooms.ts` and `rooms.ts`, `RoomPost.answers`, set from the turn's post or the call's `reply_to` |
| When 👀 comes off and when a thread is marked done | `packages/pi-host/src/durable/agent-profile.ts`, `workSteps` |
| How posts stack and show what they answer | `apps/chat/web/src/pages/channel/rows.ts` and `MessageRow.svelte` |
| Prime chat tone | `config/AGENTS.md` rule 5 and the chat brief guidance |

A comm thread's prompt also carries Prime's whole VP chat brief, so a room rule that differs from it says in the role text that it replaces the brief's line.
To see what a live comm thread got, read its newest `pi.system` entry from `~/.prime/agent/pi-host/durable/threads/<thread>.sqlite`, or run `scripts/prompt-parity.mjs`.

## A behavior change is done when a blind fresh session behaves

Unit tests prove the text and the guard, but only a fresh agent shows whether the model follows them.
So a change to how agents write is done only when a blind fresh session, given the owner's real kinds of asks with no steering, replies like the ideal pairs (c84).

1. Write the ideal replies first, as before and after pairs from real posts, before you change any prompt.
2. Change the code defaults and tool text, test them, push, and release apps/chat and pi-host on every box.
3. Run `node apps/chat/scripts/blind-replies.mjs --out ~/work/<job>/blind-runs.jsonl` against live :5184, and `node apps/chat/scripts/blind-reactions.mjs --out ~/work/<job>/reaction-runs.jsonl` for reactions and threads.
   For lists, run `blind-replies.mjs --set lists --cwd /home/sieun/src/sieun-pi`, which asks for a multi-result check and a one-line answer.
   For a list of options (rule 10), run `blind-replies.mjs --set options`, which asks what other apps do for a feature.
   For the thread done flag, run `node apps/chat/scripts/blind-thread-done.mjs --out ~/work/<job>/blind-runs.jsonl`, which checks the root reads done after the answer, open after an owner follow-up and done again after its answer.
4. The script makes a `test: true` agent and channel, posts the asks as the owner with no hint about format, and checks each answer for one post, no table, no labels and the rule 5 lengths, and with `--set lists` for a one-line answer over nested bullets and a task list, and for one short line.
5. Read every reply yourself against the pairs, because tone is a judgment the script cannot make, and take a shot of the thread pane.
6. Record each run's pass or fail with its replies in the job's wiki folder.
7. On a fail, change the code defaults or the tool text and run again with a new agent, until a run passes.

Never steer the test agent, never tell it it is a test, and never reuse an agent that saw an earlier run, because each of those makes the run no longer blind.
Any walk on live :5184 that needs an owner send, blind or not, makes its own agent and room with `test: true` (`POST /api/agents`, `POST /api/rooms`) or runs the fixture, never types into a real agent's DM, and archives them after the walk, because on 10-29 a walk's probes in dm_vent became owner posts that vent answered as his asks.

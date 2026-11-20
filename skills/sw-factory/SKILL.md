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
[Ideal Slack replies in sw factory rooms](wiki:agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html) holds 12 real before and after pairs, and every change to reply behavior aims at them.

1. The answer comes in the first few words, such as "yes", "nope", "not yet" or "got it".
2. One answer is one post of one or two short sentences, and two of his waiting posts get one post.
3. Lowercase and a fitting emoji are fine, and labels, bold, headings and bullet reports are out.
4. A post holds no table unless he asked for one, and its detail goes on a wiki page linked in the same post.
5. When a reaction says it all, the agent reacts and posts nothing.

## Reactions and threads

The owner wrote on 11-20 in #sw-factory-build: "시작하면서 눈까리 붙였으면 끝났을 떄 떼야지 / 체크도 남발하지 마 제발 the final outcome should ALWAYS act like a Slack thread".

1. An agent puts 👀 on a post when it starts on it, and takes 👀 off in the same turn its reply to that post goes out, also when more work goes on after the reply.
2. The reply is the outcome, so a post the agent replied to keeps no emoji of the agent's, and ✅ goes only on a quick ask where a reply would add nothing.
3. A post that a reaction answers, such as "ok thanks", gets that one reaction and no post.
4. A result posts as a reply in the thread of the post it answers, never as a new post in the channel.
5. A result that comes later, in a work thread's report, names its post with tell_owner's `reply_to`, and apps/chat puts it in that post's thread and sets `answers` (`repliedPost` in `apps/chat/server/reactions.ts`).
6. No code sets or clears a reaction (c210), so these rules live in the comm role text and the blind run checks them.

## Where reply behavior lives

Put behavior in code defaults and the tools' own text first, and never in a reminder (c130).

| What | Where |
|---|---|
| Comm thread role text, DM and group | `packages/pi-host/src/durable/agent-profile.ts`, `slackPostStep` and `richPostStep` |
| Refusals and notes on a comm post | `packages/pi-host/src/durable/comm-guard.ts`, run from `prime-chat.ts` |
| How a post is stored and which owner post it answers | `apps/chat/server/group-rooms.ts` and `rooms.ts`, `RoomPost.answers`, set from the turn's post or the call's `reply_to` |
| When 👀 comes off and when ✅ goes on | `packages/pi-host/src/durable/agent-profile.ts`, `workSteps` |
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
4. The script makes a `test: true` agent and channel, posts the asks as the owner with no hint about format, and checks each answer for one post, no table, no labels and the rule 5 lengths.
5. Read every reply yourself against the pairs, because tone is a judgment the script cannot make, and take a shot of the thread pane.
6. Record each run's pass or fail with its replies in the job's wiki folder.
7. On a fail, change the code defaults or the tool text and run again with a new agent, until a run passes.

Never steer the test agent, never tell it it is a test, and never reuse an agent that saw an earlier run, because each of those makes the run no longer blind.

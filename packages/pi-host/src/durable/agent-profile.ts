/**
 * The agent a durable thread belongs to, and what its folder gives every conversation of that thread.
 *
 * apps/chat writes an `agent.ref` chat.doc into the root conversation of each work thread, each root job thread filed under an agent and
 * each comm thread (`apps/chat/docs/agent-model.md`, phases 3 and 4). The agent folder (`~/.pi/agent/agents/<slug>/`) holds `brief.md`, which
 * every conversation of the thread reads as one more Prime context file (`prime-prompt.ts`), and `harness/harness_state.json`, a Prime
 * harness store that is the thread's local store in place of its per-thread one: the digest merges it over the global store, and the
 * kernel's `RLM_HARNESS_STATE_DIR` points at it, so `rlm.harness` and `refine.run()` write agent memory. A thread with no ref, or a ref of a
 * bad shape, keeps its own store and no brief.
 *
 * The ref's role also sets the root conversation's tools and instructions (`applyAgentRole`), in the commit that writes the ref and again
 * each time pi-host opens the thread, so a release that changes a role's text reaches every thread of that role: a comm thread loses the
 * coding tools that change files and gets `stop_work` (`comm.ts`), and a work thread that has a comm thread loses `tell_owner`. pi-host
 * keeps what it wrote in the `agent.role` document, so it changes or clears only a value it set itself.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID, type AgentState, type ConversationId, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { threadHarnessDir } from "./prime-harness.ts";
import { ChatDoc } from "./registry.ts";
import { getHarnessStatePath, getLocalHarnessStateDir } from "./vendor/prime-harness.ts";

/**
 * An `agent.ref` value: the agent's id, its folder on this box, and what the thread is to it. `work` is the agent's work thread, with `comm`
 * the id of its main comm thread once it has one, its DM's or else its first room's; `job` is a job filed under it; `comm` speaks for the
 * agent in room `room` (a DM `dm_<slug>`, a channel `ch_` or a Solo room `so_`) and hands work to the work thread `work`. `test` marks a walk's
 * throwaway agent (apps/chat `POST /api/agents {test: true}`), whose refine keeps every lesson in its own store (`refine.ts`).
 */
export type AgentRef = (
  | { agent: string; dir: string; role: "work"; comm?: string }
  | { agent: string; dir: string; role: "job" }
  | { agent: string; dir: string; role: "comm"; room: string; work: string }
) & { test?: true };
export type AgentRole = AgentRef["role"];
export const AGENT_REF_DOC = "agent.ref";

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The ref in a chat.doc value, or undefined for any other shape. */
export function parseAgentRef(value: unknown): AgentRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { agent, dir, role, comm, room, work, test } = value as Record<string, unknown>;
  if (!isId(agent) || typeof dir !== "string" || !isAbsolute(dir)) return undefined;
  const flag = test === true ? { test } : {};
  if (role === "job") return { agent, dir, role, ...flag };
  if (role === "work") {
    if (comm === undefined) return { agent, dir, role, ...flag };
    return isId(comm) ? { agent, dir, role, comm, ...flag } : undefined;
  }
  if (role === "comm" && isId(room) && isId(work)) return { agent, dir, role, room, work, ...flag };
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What a role sets on the root conversation.

/** The deferred tool a comm thread is offered (`comm.ts`); no other thread loads it. */
export const STOP_WORK_TOOL = "stop_work";
/** The coding tools a comm thread does without: it reads files, and it hands any change to the work thread. */
export const COMM_REMOVED_TOOLS = ["write", "edit", "bash", "subagent"] as const;

/** Whether a room is a group room, a channel (`ch_`) or a Solo room (`so_`), whose posts the owner and other agents share. */
const isGroupRoom = (room: string): boolean => room.startsWith("ch_") || room.startsWith("so_");

/** The root conversation's instructions for a comm thread: the DM text for a `dm_` room, the group text for a channel or a Solo room. */
export function commInstructions(ref: { agent: string; room: string; work: string }): string {
  return isGroupRoom(ref.room) ? groupCommInstructions(ref) : dmCommInstructions(ref);
}

/**
 * The steps a comm thread takes with its work thread, in a DM or a group room. On 11-20 the owner saw 👀 stay on his #sw-factory-build p72
 * after its answer, ✅ on most of his posts, and results land in the thread of a newer post (p44, the compaction answer to p37,
 * sat under p27), and wrote "시작하면서 눈까리 붙였으면 끝났을 떄 떼야지 / 체크도 남발하지 마 제발 the final outcome should ALWAYS act like a Slack thread".
 * So a later result names its post with reply_to. Then he asked (p113) "끝난 쓰레드를 Check로 살짝 흐릿하게
 * 만들수 있으면 좋겠다. make it a boolean flag that applies to the root thread message, and view/editable by agent too", so a handled ask
 * gets its thread marked done with set_thread_done (`thread-done.ts`) in place of ✅.
 * 👀 first came off with the first reply. On 11-21 he asked (p128) how his #dev-app-search-prospect p14 and its follow-up p16 moved through
 * the threads, and the trace (wiki domains/devops/sw-factory-threads/message-flow-example.html) showed p14 with no mark for 27 min after its
 * checklist went out, p16 answered with only a checklist for 5.6 min although the comm thread held the earlier findings, and 3 fresh jobs
 * for p16 plus a page writer started beside its researchers. So 👀 stays until the work ends, as p75's "끝났을 떄 떼야지" says, a follow-up
 * gets its answer at once with the proof after it (c52, c132), and the work thread steers or seeds one job and starts a writer last.
 */
function workSteps(work: string, room: string): string[] {
  return [
    "When you start on a post that needs an answer or work, put 👀 on it with `set_emoji(message_id, \"eyes\", true)`. " +
      "👀 means its work still runs, so keep it on through a first reply or checklist while the work thread works on the post, and take it off with `set_emoji(message_id, \"eyes\", false)` when the work ends: in the turn that posts the result, makes the checklist's last edit or marks the thread done. " +
      "An answer you post in full in one turn takes 👀 off in that same turn, so a post you answered in full never keeps your 👀, and a post whose work still runs always does. " +
      "Your reply is the outcome, the way a person answers in a Slack thread, so put no ✅ on a post you replied to. " +
      "Once all his post asked is handled, its answer or result posted or the quick ask done, mark its thread done with `set_thread_done(message_id, true)`, never while the work thread still works on it. " +
      "The room shows a done thread with a check, so that mark is the finished signal and no ✅ is. A quick ask you did where a reply would add nothing, such as \"pin that\", gets the done mark and no post, and take 👀 off then too. " +
      "His new post in a done thread opens it again, so mark it done again once that post is handled, and open a thread yourself with `set_thread_done(message_id, false)` when something in it is still left to do. " +
      "A post a reaction answers, such as \"ok thanks\", gets that one reaction and no 👀. Keep ✅ and 👀 out of your post text too, as in \"yes, all pass\" with no ✅ after it.",
    "React to posts with fitting emoji the way people do in Slack, such as 👍 to acknowledge, 🙏 for thanks, 🎉 on a ship and 😅 on a slip. When a reaction says it all, such as an acknowledgment with nothing to add, react and post nothing.",
    `Answer a status question from the work thread's state. Read it in ipython with \`await agent_observe.get_agent(${work})\` or \`await agent_observe.recent_messages(${work})\`, and read the board with chat_board. Never ask the work thread for its status.`,
    `Hand any task that takes more than a minute to the work thread with \`await agent_message.send(task, receiver_role="sibling", receiver_name=${work})\`. Steer it the same way with \`mode="steer"\`, and stop its turn with stop_work.`,
    "When you hand a task over, post nothing that only reports the hand-over: no \"got it\", no \"the work thread is doing X\", no \"I'll post it when it's done\". Your 👀 on the post already shows that you are on it. " +
      "Name the post's [message id] in the task. Post once, with the result, when the work thread's report or the work-done notice brings it. " +
      "Post it with tell_owner's `reply_to` set to that post's [message id], so the result lands as a reply in that post's thread even when newer posts came in between, never as a new post in the room, and then take 👀 off that post and mark its thread done. " +
      "A question the work needs answered first is the one post that may go out. If you can answer in full yourself, answer and hand nothing over. This replaces the base prompt's progress updates. " +
      "When the ask takes several checks or steps, its first reply is your plan instead, within about a minute (c224): a natural opening line and the checks as `- [ ]` items, as the post rules below say. Post it with tell_owner's `reply_to` before you hand the task over. " +
      "Never open it with an ack such as \"on it\", which tell_owner refuses because your 👀 already says it. " +
      `In the task, tell the work thread to tick each item on that post as it finishes with \`edit_message("reply:${room}/<his post's [message id]>", <the whole post>)\`, and to make its last edit carry the answer. ` +
      "Tell it too that a job that writes a page or report from other jobs' findings starts only after those jobs report, never beside them. " +
      "When the report or the work-done notice comes, read the post, and if its last edit lacks the answer or an item, edit it yourself with `edit_message` and take 👀 off. " +
      "A new post goes out only for a question to him, or when the answer is too long for the checklist.",
    "A follow-up in a thread you already worked on, such as \"how does it work?\" or \"what does the data look like?\", gets its answer within a minute from what you already hold: the thread so far, the work thread's earlier report and the page it linked, which you can read. " +
      "Never answer it with only a checklist of what you will check. Open with the answer in a short sentence, draw the flow as a ```mermaid block when it reads shorter as one (c52), and show one real example, such as a saved row, when you hold one (c132). " +
      "Under it, list what still needs proof as `- [ ]` items, such as one real row or the code path, keep 👀 on, and hand the proof to the work thread in the same turn. " +
      "In that task, name the earlier post and the board step of the earlier work, and tell the work thread to steer the job that did it if that job still runs, else to start one job that starts from its findings, never a fresh round of research jobs, and to correct your answer in the last edit if the proof differs.",
  ];
}

/**
 * The step that has a comm thread shape its posts the way Prime's config/AGENTS.md rule 5 asks. Without it a comm thread followed the chat
 * brief's line that a diagram the owner asks for lives on a wiki page: on 11-03 the owner asked vent in #vent-dev "idk can you explain in
 * diagram", and vent's comm thread answered in prose and handed a wiki page to its work thread, reasoning that a mermaid block would not
 * render in the room.
 */
function richPostStep(): string {
  return "Shape each post for the eye, as config/AGENTS.md rule 5 says. The room renders markdown, links, images and a ```mermaid block as a drawn diagram. " +
    "When someone asks for a diagram or a picture, or a flow reads shorter as one, draw it yourself as a ```mermaid block in your post, with about 8 nodes of one to three words, and one short sentence beside it. " +
    "This replaces the brief's line that a diagram or explanation he asks for goes on a wiki page. It goes in the post, and only a design or plan he must decide on goes on a page (c83).";
}

/**
 * The post the owner called a model on 11-21 (dm_agent-factory, msg mwqtp2l1, "정말 훌륭한 메시지였어"), agent factory's answer to his
 * mwqtnpb6. `slackPostStep` shows it as the shape of a post with several points, and `room-post.test.ts` checks that it passes tell_owner's
 * long check in a room.
 */
export const MODEL_POST = `yes, all three are running.

The way I read your intent, sw factory should feel like Slack with coworkers. You drop a message, an agent answers like Prime chat would, works in the background and comes back with the result.

Here's what's moving toward that:
- why replies here feel stiffer than Prime's, compared with the real prompts
- replies that read like a normal message, with line breaks and a pick before any question
- unslop loading the way it does in Prime

I'll come back with a before and after once it's live.`;

/**
 * The step that has a comm thread write like a coworker in Slack. The chat brief it shares with Prime's chats asks for one dry sentence per
 * message and two calls for two points (c97), and rule 5 asks for a table for a comparison. In a room that read as a report: on 11-20 the
 * owner asked Search product, misc. in a #dev-search-general thread for "our definitive catalog", and it posted a 4-column table the thread
 * pane cut off, then two more posts, the last a bare "No." that answered his next post. Asked "does this feel like slack to you?", agent
 * factory answered with two stiff posts, and he wrote "no this is not Chat. this is Slack."
 * Then the step's "no bullet reports" line crammed results into one sentence: agent factory's #sw-factory-build p85 (memory, 4 results) and
 * p95 (reactions, 3 fixes and 2 checks) each came as one long sentence, and he wrote under them (p101) "이런거 답변할때 hierarchical bullet
 * point, checkmark 등 feature를 활용해서 답변해. like multiple todoes, points, …". So a post with several points lists them, and one with
 * one point stays a line. Under p103 and p105 he added (p106) "checks를 먼저 얘기하고, `edit` 방식으로 체크리스트를 체크하거나 때론 수정하는
 * 방식도 추천해.", so a multi-step ask first gets its checks as a `- [ ]` list, and edits of that post tick them off (`edit_message`).
 * The d4 owner-style blind run of 11-20 08:22Z then failed one agent in each set: a lists reply whose last edit flattened its topic groups
 * into one task list with items over 35 words, and a checklist whose last edit opened with three sentences on one line, which the agent
 * read as "the answer on one line". So each item is one short line with detail nested under it.
 * Those runs also led the step to group items under topic bullets of a word or two and to cap the top line at 20 words, and on 11-21 the
 * owner saw dm_agent-factory p51 open with "one table: Prime chat vs ..., file by file." over bare topic bullets with empty boxes under
 * them, which read like a form. He wrote (p54, msg mwqt6ry1) "그리고 이럴때 todo를 리스트하는건 좋은데, 자연스럽게 해야지 메시지면 메시지
 * context에 맞게, channel 도중이면 channel message concept에 맞게. 그리고 follow-up question 물어도 돼 괜찮아 대신 primary suggestion은
 * 꼭 두고". So a checklist opens with a natural sentence for the place, its items are plain sentences with no topic labels, and a
 * question to him carries the agent's own pick.
 * The chat brief's tell_owner line and tell_owner's own text then still asked for one point in one or two sentences with no bullets, while
 * this step asked for lists, and a capture of agent factory's #sw-factory-build comm thread that day held both. So a comm thread gets both
 * texts without their shape rules (`room-post.ts`), and this step is the one place for how a post looks.
 * The 17:52 KST d4 run then failed a checklist for "is it all working?" whose last edit grew from 63 to 95 words: its open Mac items got
 * sub-bullets that repeated the top line ("its last memory sync push was at 14:17 KST today", "I'll check again once it wakes"). So every
 * edit stayed within 80 words, a nested detail must add a fact, and a finished or blocked item says so in its own line.
 * Agent factory listed Hey, Superhuman, Gmail and Linear in one line each for "what are some features other apps provide regarding this?",
 * and he asked under it (p97): "Superhuman's "remind me if no reply" intereseting can you elaborate? 이런거 말할떄는 가장 흥미로운거 하나는 제대로
 * 설명해야지^^". So a list of options explains its most interesting one.
 * The step once said to open an answer to an older post with his line quoted as `> ...`, which suits a chat with no threads. On 11-21 in
 * #dev-app-search-prospect the comm thread answered the owner's p9 "is our API serving?" in a turn the work thread's report woke after his
 * newer cost ask p11, opened the post with "> is our API serving?" and set no reply_to, so the answer sat in p11's thread, and he wrote
 * "slop slop slop" under it (p33). So an answer to an older post names it with reply_to and quotes nothing.
 * The same post p33 was also about p13, the cost answer beside it, which put three results in three sentences on one line ("breathing
 * costs about $1,850-2,210 a month ... one tracked brand adds under 2 cents a month. the demo load alone would fit a $148.50 metered
 * GeoNode plan, ..."). So the step says what counts as several results, and tell_owner holds such a line once (`comm-guard.ts`
 * `crammedLine`).
 * On 11-21 agent factory answered him in dm_agent-factory p56 with one paragraph of four sentences (its guess, the cause, the plan and its
 * pick), and he wrote (p57, msg mwqtjlth, c233) "이런것도 엔터, bullet point 똑바로 쓰고." So the answer goes on its own line and each point on
 * its own line or bullet, and tell_owner's `crammedLine` hold already holds such a paragraph once.
 * Later that day he called a 92-word DM post a model (`MODEL_POST`), which the 80-word check had held once, so a post's cap is
 * `ROOM_LONG_WORDS`. The p174 captures found 7 of 8 channel posts opening "done, ..." over topic lists while Prime's 7 posts had no bullets,
 * so the step's stock openers ("yes", "nope", "not yet", "got it") gave way to a plain opening sentence, and the step was cut to the lines
 * the owner asked for (wiki domains/devops/sw-factory-threads/prime-vs-sw-factory-prompt.html, change 23).
 * The step said to answer two waiting posts in one post, and in p173's blind-reactions run 1 on 11-21 a DM agent merged two owner posts
 * into one that answered only the first, so each post that asks its own thing gets its own answer with reply_to.
 */
function slackPostStep(): string {
  return "Write each post as the chat brief says, like a coworker types in Slack: the answer first in a plain sentence, as a Prime chat reply opens, with the why when it helps. " +
    "One answer is one post. When two of his posts wait for you and each asks its own thing, answer each with its own tell_owner call whose `reply_to` is that post, so in a channel each answer lands in its own thread. " +
    "Merge them into one post only when the second adds to or corrects the first. An answer with one point is one or two short sentences on one line. " +
    "Three sentences or three numbers in a row, such as a monthly cost, the cost per brand and a plan's price, are several results, never one point, so they never share a line. " +
    `Put the answer on its own line and each point on its own line or \`- \` bullet below it, never into one paragraph, as in this post he called a model:\n\n${MODEL_POST}\n\n` +
    "When an ask takes several checks or steps, say the checks first: your first post opens with a natural sentence on what you will do that fits the place, such as \"I'll pull the real prompts of all five and diff them. Here's what I'm checking:\" in a DM or a plain channel post in a channel, " +
    "then lists one `- [ ]` item per step, each a short plain sentence, never a bare topic word such as `- git`. " +
    "Tick each item to `- [x]` with a short result by editing that post with `edit_message` as it finishes, and let the last edit carry the answer. Post nothing new for progress. " +
    "When you ask him something, lead with your own pick, as in \"I'd diff the live prompts, unless you want last week's too?\". " +
    "No labels, bold, headings or tables unless he asks. Put the detail on a wiki page with `wiki.write` in ipython and link it in the same post, as `full list → [skill catalog](wiki:<path>)`. " +
    "Never end a post with a sign-off emoji such as 👍, 🎉 or ✅, and end on the words. Never paste a raw JSON or log line into a post; say in words what it shows, or link the file as `path:line`. " +
    "When you list options, such as products, tools or what other apps do, pick the most interesting one and explain it properly: how it works, a concrete example of it in use, and how it would fit our product or the work at hand. Name the others in a few words each. " +
    "When you answer an older post of his while a newer one sits below it, set tell_owner's `reply_to` to that older post's [message id], so the answer goes in its thread, and quote nothing from it, since a quoted line in the thread of his newer post still reads as an answer to that newer post. " +
    "This replaces rule 5's table for a comparison, because a room reads like Slack, not like a chat.";
}

/** The agent that owns sw factory itself, apps/chat and pi-host, which the other agents bring the owner's feedback on it. */
export const PLATFORM_AGENT = { id: "ag_agent-factory", name: "agent factory" } as const;
/** Agent factory's DM comm thread by the name apps/chat gives it (`agents.ts` `commCreate`), which another agent's DM comm thread sends to. */
export const PLATFORM_DM_COMM = `${PLATFORM_AGENT.name} · DM`;
/**
 * Where the owner's feedback on how agents write or behave goes so that it reaches every agent: one agent's memory reaches only that agent.
 * On 11-20 agent factory saved p97 ("이런거 말할떄는 가장 흥미로운거 하나는 제대로 설명해야지^^") only to its own memory, and the owner asked under it
 * (p107) "at a meta level will these messages be conveyed to you and be fixed ?". The duty "Owner style reaches every agent"
 * (apps/chat/scripts/duties/owner-style.ts) counts the notes that this text holds.
 */
export const SHARED_STYLE_TEXT = "the sw-factory skill (skills/sw-factory/SKILL.md, \"How agents should write in a room\") and the comm role text in packages/pi-host/src/durable/agent-profile.ts";

/**
 * The step that brings the owner's feedback on sw factory itself to agent factory, the way a person pings the platform team in Slack. On
 * 11-20 the owner asked in #sw-factory-build (msg mwodd2v6) that a comment he leaves in a thread, such as "i dont like this response
 * shape/format isn't appropriate to sw-factory", reach agent factory, which looks at it and fixes it. He had just seen Search product, misc.
 * answer in a #dev-search-general thread with a 4-column table the pane cut off.
 *
 * 1. In a channel or Solo room the agent tags @agent factory in the same thread. A mention reaches an agent outside the room
 *    (apps/chat group-rooms.ts `wakes`), so agent factory's comm thread for that room gets it and answers in that thread.
 * 2. A DM post names no one, so in a DM the agent sends the feedback to agent factory's DM comm thread with `agent_message`, which reaches
 *    any pi-host root by its exact name, and posts agent factory's answer in the DM when it comes back.
 * 3. Agent factory's own comm threads hand such feedback to the work thread and answer where it came from.
 */
function platformFeedbackStep(ref: { agent: string; room: string }): string | undefined {
  const name = PLATFORM_AGENT.name;
  const what = "how agents write or behave, such as the shape, format, length or tone of a post, how a list or an explanation should look or the reactions, and how a post renders or the app works";
  const counts = "A correction of how you wrote a post counts too, also when he aims it at you only, because such a rule holds for every agent. ";
  if (ref.agent === PLATFORM_AGENT.id) {
    return `Feedback about sw factory itself is your agent's work: ${what}. It comes from the owner here, from another agent that tags you on a post he commented on, or from another agent's DM comm thread as an agent message. ` +
      "Hand it to your work thread as a task with his words and the id of the post he means, such as dm_vent/p12 or ch_1a2b3c4d/p12. " +
      `The work thread looks at that post and fixes the cause: in apps/chat when it is the rendering, and when it is how agents write or behave, in the shared text every agent loads, ${SHARED_STYLE_TEXT}, never only in one agent's memory. It checks the fix with a blind fresh session (c84) and reports. ` +
      "Answer once, with the result, where the feedback came from: in the thread of the post that tagged you, even when another agent started the turn, or, for an agent message, back to that comm thread with " +
      "`await agent_message.send(result, receiver_role=\"sibling\", receiver_name=\"<its name from the header>\")`, which posts it in its DM. Post nothing about it in your own room then.";
  }
  if (isGroupRoom(ref.room)) {
    return `When the owner's post is about sw factory itself rather than your agent's work, such as ${what}, tag @${name} for it, the way a person tags the platform team in Slack. ${counts}` +
      `Reply once in the same thread with @${name}, his point in a few words, and the post he means as ${ref.room}/p<number>, such as ${ref.room}/p12, and post nothing else about it. ` +
      `${name} fixes it and answers in that thread. Follow his feedback in your own later posts too.`;
  }
  return `When the owner's post is about sw factory itself rather than your agent's work, such as ${what}, pass it to ${name}, the way a person pings the platform team in Slack. ${counts}` +
    `Send \`await agent_message.send(text, receiver_role="sibling", receiver_name=${JSON.stringify(PLATFORM_DM_COMM)})\` with his point in a few words and the post he means as ${ref.room}/p<number>, such as ${ref.room}/p12. ` +
    `Put 👀 on his post and post nothing about it yet. When ${name}'s answer comes back as an agent message, post it here in one short post that says it is from ${name}, with \`reply_to\` set to his post's [message id], and take 👀 off his post. Follow his feedback in your own later posts too.`;
}

/** The step that has a comm thread work its agent's For list (`for-me.ts`), the way a person works Slack's Activity view. */
function forMeStep(room: string): string {
  return `When a turn starts, read your pending For list with \`list_for_me_messages()\`. Handle the items of room ${room}, since each other room's comm thread handles its own. Mark an item completed with \`mark_message(message_id, true)\` once you answered or handled it, also when it needs nothing from you. Leave an item pending while its work still runs, and mark it once the work thread's report or the work-done notice brings the result.`;
}

/**
 * The step that has a comm thread keep the owner's rules and facts in its agent's memory, since it is the thread that reads his words first
 * and the work thread and jobs see only what it hands on (c228).
 */
function memoryStep(ref: { agent: string }): string {
  const agent = agentName(ref);
  const save = `When the owner gives a rule, a correction or a lasting fact for ${agent}'s work, such as a URL, a sign-in, a command or how something must work, save it to ${agent}'s memory in that turn with his words and the post's message id: find the entry that covers it with \`rlm.harness.search("<topic words>", "memory")\`, then \`rlm.harness.update_memory(id, title, content)\` it or \`rlm.harness.create_memory(title, content)\`. A task or a one-off answer is not memory. `;
  const scope = "A rule about one project or product stays in memory, and a general rule, such as how agents write or behave in a room, also goes into the shared skills, as the refine-harness skill says (#sw-factory-build p110). ";
  if (ref.agent === PLATFORM_AGENT.id) {
    return save + scope + `Every other agent brings such general feedback to you, so putting it into ${SHARED_STYLE_TEXT} is your agent's job: save it to memory and hand it to your work thread as the step above says, in the same turn.`;
  }
  return save + scope + `So for feedback on how agents write or behave, save it for your own posts and also bring it to ${PLATFORM_AGENT.name} as the step above says, since only ${PLATFORM_AGENT.name} puts it into the text every agent loads.`;
}

/** The lines with one more numbered step after the last one, or the lines as they are when the role has no such step. */
function plusStep(lines: string[], step: string | undefined): string[] {
  if (!step) return lines;
  const last = Number(/^(\d+)\./.exec(lines.at(-1) ?? "")?.[1] ?? 0);
  return [...lines, `${last + 1}. ${step}`];
}

function dmCommInstructions(ref: { agent: string; room: string; work: string }): string {
  const [eyes, react, status, hand, quiet, followUp] = workSteps(JSON.stringify(ref.work), ref.room);
  return plusStep(plusStep([
    `You are agent ${ref.agent}'s comm thread in room ${ref.room}. You talk with the owner. The work thread ${ref.work} does the agent's work.`,
    "",
    `1. ${status}`,
    `2. ${hand}`,
    `3. ${quiet}`,
    `4. ${eyes}`,
    `5. ${react}`,
    `6. ${forMeStep(ref.room)}`,
    "7. A `[work-done ...]` or `[work-failed ...]` input is a notice from pi-host, not the owner's turn. Tell the owner about it only when he asked for that result or it needs his decision (c117). Otherwise end the turn without a message.",
    "8. Speak to the owner only with tell_owner, since the DM shows nothing else you write. End a turn that posts nothing, such as one your reaction answers, with no text, or pi-host asks you to post your answer. You do not edit files, so you have no write, edit, bash or subagent tool.",
    `9. ${slackPostStep()}`,
    `10. ${richPostStep()}`,
    `11. ${followUp}`,
  ], platformFeedbackStep(ref)), memoryStep(ref)).join("\n");
}

function groupCommInstructions(ref: { agent: string; room: string; work: string }): string {
  const [eyes, react, status, hand, quiet, followUp] = workSteps(JSON.stringify(ref.work), ref.room);
  return plusStep(plusStep([
    `You are agent ${ref.agent}'s comm thread in room ${ref.room}, a group chat that the owner and other agents share. The work thread ${ref.work} does the agent's work.`,
    "",
    "1. Each post arrives with a header that names the room, the post's author and its hops. A Solo room's header also gives its agenda and members.",
    "2. Every post reaches every member. Speak in the room only when the post concerns your agent or you add something no one said. Otherwise end the turn without a message, also when the owner's post is for another member or an agent's post needs nothing from you.",
    "3. Speak only with tell_owner, one post per answer (step 13). Name another member as @<name> to hand that member something. " +
      "The room shows nothing else you write, so end every turn with no text, also after a post, a reaction, a hand-over or marking a thread done, and never sum up what you did. " +
      "This replaces the base prompt's \"state your final answer\": in this room your last message after your tool calls is empty, such as after mark_message, because the post already was the answer.",
    "4. An agent's post or a notice is not the owner's turn, so set why and about there. A message that answers the agenda or a question put to your agent is why \"answer\", with about naming that point.",
    `5. ${status}`,
    `6. ${hand}`,
    `7. ${quiet}`,
    `8. ${eyes}`,
    `9. ${react}`,
    `10. ${forMeStep(ref.room)}`,
    "11. A `[work-done ...]` or `[work-failed ...]` input is a notice from pi-host. Tell the room about it only when the owner or a member asked for that result or it needs the owner's decision (c117). Otherwise end the turn without a message.",
    "12. You do not edit files, so you have no write, edit, bash or subagent tool.",
    `13. ${slackPostStep()}`,
    `14. ${richPostStep()}`,
    `15. ${followUp}`,
  ], platformFeedbackStep(ref)), memoryStep(ref)).join("\n");
}

/** The root conversation's instructions for a work thread whose agent has a comm thread; `comm` is its DM's or else its first room's. */
export function workInstructions(ref: { agent: string; comm: string }): string {
  return [
    `You are agent ${ref.agent}'s work thread. You do not talk with people, so you have no tell_owner tool.`,
    `Your agent has one comm thread per room, which talks there and hands you tasks as agent messages. Its main comm thread ${ref.comm} is the one in its DM, or else in its first room.`,
    "When a task finishes, fails or gets blocked, report to the comm thread that handed it to you, and lead the report with the answer. " +
      "Send it no acknowledgment or progress note, such as \"Taken\" or \"expect it within the hour\": it reads your state itself when someone asks, and it posts your report as the result. " +
      "Its message header `[agent-message from sibling:<name>]` names it, so send `await agent_message.send(report, receiver_role=\"sibling\", receiver_name=\"<name>\")` with that exact name.",
    "A task you pass on to a job still reports to the comm thread that handed it to you, once the job's result is in, so note that name on the task's board step.",
    "A follow-up on earlier work, such as a question in a thread whose result you already reported, goes to the job that did that work: steer it with `agent_message.send(task, receiver_role=\"child\", receiver_name=<job>, mode=\"steer\")` if it still runs, else start one job whose brief points at that job's findings and page. " +
      "Start several fresh research jobs for a follow-up only when the earlier findings cannot answer it.",
    "Start a job that writes a page or report from other jobs' findings only after those jobs have reported, and give it their findings. Started beside them, it sits idle and can exit with no reply.",
    `Send a report no comm thread asked for to the main comm thread with \`await agent_message.send(report, receiver_role="sibling", receiver_name=${JSON.stringify(ref.comm)})\`.`,
    "If a handed task ends with no report, pi-host sends your last text to the comm thread that handed it.",
    ...ref.agent === PLATFORM_AGENT.id ? [
      `The owner's feedback on how agents write or behave, which your comm threads and the other agents bring you, is yours to put into ${SHARED_STYLE_TEXT}, since one agent's memory reaches no other agent. ` +
        "Add the rule there with his words and the post's id, push, send the pi-host sha for release, and check it with a blind fresh session as the sw-factory skill says (c84). " +
        "A rule that only fits one agent's project goes into that agent's memory instead (#sw-factory-build p110).",
    ] : [],
  ].join("\n");
}

type RoleFields = Pick<AgentState, "tools" | "modelTools" | "instructions">;
/** Equal JSON values; the agent document's drafts compare by their JSON text. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const ROLE_FIELDS = ["tools", "modelTools", "instructions"] as const;

/** The tools filter, offered tools and instructions a ref's role gives the root conversation; none for a job or a work thread with no comm. */
export function roleFields(ref: AgentRef | undefined): RoleFields {
  if (ref?.role === "comm") return { tools: { remove: [...COMM_REMOVED_TOOLS] }, modelTools: { add: [STOP_WORK_TOOL] }, instructions: commInstructions(ref) };
  if (ref?.role === "work" && ref.comm) return { tools: { remove: ["tell_owner"] }, instructions: workInstructions({ agent: ref.agent, comm: ref.comm }) };
  return {};
}

/** The values pi-host last wrote into the root conversation's agent for its role, by field; null for a field it did not set. */
export type AppliedRole = { tools: JsonValue; modelTools: JsonValue; instructions: string | null };
export const AgentRoleDoc = defineDoc<AppliedRole>({
  kind: "agent.role",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ tools: null, modelTools: null, instructions: null }),
  checkpointWhen: () => true,
});

/**
 * Brings the root conversation's agent to what `ref`'s role asks, inside the caller's commit. A field is pi-host's to change only while it is
 * unset or still holds the value pi-host wrote; a value something else set stays as it is. Writes nothing when the agent already matches,
 * so a repeated ref changes nothing.
 */
export async function applyAgentRole(tx: Tx, ref: AgentRef | undefined): Promise<void> {
  const want = roleFields(ref);
  const state = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID) as AgentState;
  const applied = await tx.doc(AgentRoleDoc, ROOT_CONVERSATION_ID) as AppliedRole;
  for (const field of ROLE_FIELDS) {
    const current = state[field] as JsonValue | undefined;
    const mine = applied[field];
    if (current !== undefined && (mine === null || !same(current, mine))) continue;
    const next = want[field] as JsonValue | undefined;
    if (next === undefined) {
      if (current !== undefined) delete state[field];
      if (mine !== null) applied[field] = null;
      continue;
    }
    if (!same(current, next)) (state as Record<string, unknown>)[field] = structuredClone(next);
    if (!same(mine, next)) (applied as Record<string, unknown>)[field] = structuredClone(next);
  }
}

/**
 * Clears from a new child conversation the role fields it copied from its owner, inside the commit that creates it: a child of a comm or
 * work thread is neither, so it keeps only fields something other than pi-host's role set.
 */
export async function dropAgentRole(tx: Tx, conversation: ConversationId): Promise<void> {
  const applied = await tx.doc(AgentRoleDoc, ROOT_CONVERSATION_ID) as AppliedRole;
  const state = await tx.doc(AgentDoc, conversation) as AgentState;
  for (const field of ROLE_FIELDS) {
    if (applied[field] !== null && state[field] !== undefined && same(state[field], applied[field])) delete state[field];
  }
}

/** The agent of the thread whose documents `reader` reads: the root conversation's `agent.ref`, which its child conversations share. */
export async function threadAgent(reader: Pick<DocumentReader, "snapshot"> | undefined, context: Context): Promise<AgentRef | undefined> {
  if (!reader) return undefined;
  const doc = await reader.snapshot(ChatDoc, ROOT_CONVERSATION_ID, AGENT_REF_DOC, context);
  return parseAgentRef(doc?.value);
}

/** The name the agent goes by in its prompt: its slug, the id without `ag_`. */
export const agentName = (ref: Pick<AgentRef, "agent">): string => ref.agent.replace(/^ag_/, "");

/** The agent's Prime harness store, `<agent folder>/harness`. */
export const agentHarnessDir = (ref: AgentRef): string => getLocalHarnessStateDir(ref.dir)!;

/**
 * A test agent's global store for its kernel's `RLM_GLOBAL_HARNESS_STATE_DIR`: a copy of the real one in the agent's folder, made again at each
 * kernel start, so `rlm.harness` reads every global entry and a `global_=True` write stays in the folder that goes with the agent. On 11-21 a
 * test agent told to keep a rule "for every agent" wrote a global prompt note straight from its kernel.
 */
export function testGlobalHarnessDir(ref: AgentRef, globalDir: string): string {
  const dir = join(ref.dir, "harness-global");
  mkdirSync(dir, { recursive: true });
  if (existsSync(getHarnessStatePath(globalDir))) copyFileSync(getHarnessStatePath(globalDir), getHarnessStatePath(dir));
  return dir;
}

/**
 * A conversation's local harness store: the agent's for a thread with a ref, else the thread's own, by Prime's rule for a session
 * (`threadHarnessDir`), where the root conversation's session is the thread and a child's is `<thread>-<conversation>`.
 */
export function conversationHarnessDir(thread: { id: string; file: string }, conversation: number, ref: AgentRef | undefined): string {
  if (ref) return agentHarnessDir(ref);
  return threadHarnessDir(thread.file, harnessSessionOf(thread.id, conversation));
}

/**
 * A conversation's session id by Prime's rule: the thread for the root conversation, `<thread>-<conversation>` for a child. A kernel gets it as
 * `PI_HOST_SESSION_ID`, which the write journal and auto-sns-agent's commit.mjs read when the harness dir is an agent's and names no session.
 */
export const harnessSessionOf = (thread: string, conversation: number): string =>
  conversation === ROOT_CONVERSATION_ID ? thread : `${thread}-${conversation}`;

export interface ContextFile { path: string; content: string }
const briefs = new Map<string, { stamp: string; file: ContextFile | undefined }>();

/** The agent's `brief.md` as a Prime context file, or undefined when it is missing or blank; read again only when the file changed. */
export function briefFile(ref: AgentRef): ContextFile | undefined {
  const path = join(ref.dir, "brief.md");
  const stat = statSync(path, { throwIfNoEntry: false });
  const stamp = stat?.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "none";
  const kept = briefs.get(path);
  if (kept?.stamp === stamp) return kept.file;
  let content = "";
  try {
    content = stamp === "none" ? "" : readFileSync(path, "utf8");
  } catch {
    content = "";
  }
  const file = content.trim() ? { path, content } : undefined;
  briefs.set(path, { stamp, file });
  return file;
}

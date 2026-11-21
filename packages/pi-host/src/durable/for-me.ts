/**
 * The agent's For list, its inbox like a person's Slack Activity view, through apps/chat's HTTP API (`chat-app.ts`). The chat server derives
 * the items from the room posts and keeps only the agent's marks (apps/chat/server/for-me.ts); contract: /home/sieun/work/for-agent/contract.md.
 *
 * `list_for_me_messages` reads the list and `mark_message` marks one item completed or pending again. Both run in a thread's root
 * conversation, as `set_emoji` does (`room-tools.ts`). Nothing here works the list for the agent: the comm role text asks it to read its
 * pending items when a turn starts and to mark each one once it is handled (`agent-profile.ts`).
 *
 * `forMeTools` returns the two tool definitions, which the `room-tools` extension lists beside `set_emoji` (`room-tools.ts`), so a job's
 * child conversation drops them with it.
 */
import type { Context } from "@earendil-works/chord";
import { Type, type Message } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID, type Cursor, type ToolControl, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ForMeItem, ForMeList, ForMeStatus, Principal } from "../../../../apps/chat/web/src/lib/api/types.ts";
import { threadAgent } from "./agent-profile.ts";
import type { ChatApp } from "./chat-app.ts";

export const LIST_FOR_ME_TOOL = "list_for_me_messages";
export const MARK_MESSAGE_TOOL = "mark_message";

export type ForMeFilter = ForMeStatus | "all";

export const LIST_FOR_ME_DESCRIPTION =
  "List the messages your agent is involved in, like a person's Slack Activity view: posts in your DM, posts that name you, group posts " +
  "delivered to you, replies in channel threads you posted in, and reactions on your own posts. Each item shows its message id, room, " +
  "author, time, why it is on the list, its reactions, its status and its text.";

export const MARK_MESSAGE_DESCRIPTION =
  "Mark an item of your For list completed once you answered or handled it, or pending again, as Slack's Mark unread brings a message back. " +
  "Marking it the same way twice changes nothing.";

/** The owner as an agent reads him, as in a post's reactions (apps/chat/server/reactions.ts). */
const OWNER_FOR_AGENTS = "Sieun (owner)";
const who = (p: Principal): string => (p.kind === "owner" ? OWNER_FOR_AGENTS : p.name);
const time = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/** An item's reactions in the one form every agent-facing surface shows them: `[reactions: 👀 vent, agent factory · 👍 Sieun (owner)]`. */
export function reactionsText(item: Pick<ForMeItem, "reactions">): string {
  const rows = (item.reactions ?? []).filter(row => row.by.length > 0);
  return rows.length ? `[reactions: ${rows.map(row => `${row.emoji} ${row.by.map(who).join(", ")}`).join(" · ")}]` : "";
}

/** The agent's own save of an item, in the form every agent-facing surface shows it: `[saved for later · reminder 2026-11-20 05:42Z]`. */
export function laterText(item: Pick<ForMeItem, "later">): string {
  if (!item.later?.saved) return "";
  return `[saved for later${item.later.remindAt !== undefined ? ` · reminder ${time(item.later.remindAt)}` : ""}]`;
}

/** The done flag of the item's thread in the form every agent-facing surface shows it: `[thread done by vent]`. */
export function doneText(item: Pick<ForMeItem, "done">): string {
  return item.done ? `[thread done by ${who(item.done.by)}]` : "";
}

/** One item as the agent reads it: a header line, its reactions, done flag and save when it has any, then the post's text. */
export function itemText(item: ForMeItem): string {
  const head = [
    `${item.id} in ${item.roomName}${item.threadRoot ? `, thread ${item.threadRoot}` : ""}`,
    `from ${who(item.author)}`,
    item.activityAt !== item.at ? `${time(item.at)}, active ${time(item.activityAt)}` : time(item.at),
    item.reasons.join(", "),
    item.status === "completed" && item.completedAt !== undefined ? `completed ${time(item.completedAt)}` : item.status,
  ].join(" · ");
  const marks = [reactionsText(item), doneText(item), laterText(item)].filter(Boolean).join(" ");
  return [head, ...(marks ? [marks] : []), item.text].join("\n");
}

/** The tool's answer: a count line, then one block per item, newest activity first as the server sorts them. */
export function listText(list: ForMeList, status: ForMeFilter): string {
  const counts = `${list.pending} pending, ${list.completed} completed.`;
  if (list.items.length === 0) return `${counts} No ${status === "all" ? "" : `${status} `}messages.`;
  const shown = status === "all" ? `Showing all ${list.items.length}.` : `Showing the ${list.items.length} ${status}.`;
  return [`${counts} ${shown}`, ...list.items.map(itemText)].join("\n\n");
}

/** The answer to mark_message: the mark and how many items stay pending. */
export function markedText(item: Pick<ForMeItem, "id" | "status">, pending: number): string {
  return `Marked ${item.id} ${item.status}. ${pending} pending.`;
}

/** Whether the tool runs in a comm thread; a registry with no chat.doc (a test's) reads as no comm thread. */
async function isCommThread(api: Parameters<typeof threadAgent>[0], context: Parameters<typeof threadAgent>[1]): Promise<boolean> {
  try {
    return (await threadAgent(api, context))?.role === "comm";
  } catch {
    return false;
  }
}

/** The entry kinds that start a turn: an owner post or notice, and an agent message. */
const TURN_INPUTS = new Set(["pi.user", "agent.message"]);
/** The calls that answer a post: a post or an edit of one, or a reaction other than 👀, which answers a post that needs no words. */
const answers = (name: string, args: Record<string, unknown>): boolean =>
  name === "tell_owner" || name === "edit_message" || (name === "set_emoji" && args.on === true && !["eyes", ":eyes:", "👀"].includes(String(args.emoji).trim()));

/**
 * Whether an earlier round of this turn answered: a tell_owner, edit_message or non-👀 reaction whose result came back with no error, read
 * newest first back to the turn's input. A call of the running round has no result yet, so it never counts.
 */
async function answeredThisTurn(api: ToolExecutionApi, context: Context): Promise<boolean> {
  return api.commit(async tx => {
    const ok = new Set<string>();
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100, cursor);
      for (const entry of page.items) {
        if (TURN_INPUTS.has(entry.kind)) return false;
        for (const message of (entry.model ?? []) as Message[]) {
          if (message.role === "toolResult" && !message.isError) ok.add(message.toolCallId);
          if (message.role === "assistant" && message.content.some(part => part.type === "toolCall" && ok.has(part.id) && answers(part.name, part.arguments))) return true;
        }
      }
      if (!page.next) return false;
      cursor = page.next;
    }
  }, context);
}

/**
 * The control a comm thread's closing call returns: `terminate`, so a round made only of closing calls ends the turn with no further model
 * request. The closing calls are mark_message that leaves no item pending, set_thread_done(true) and set_emoji taking 👀 off, the ones the
 * comm role text puts after the post. On 11-21 fresh channel agents in blind runs on live :5184 ended 9 of 20 turns with a summary no
 * room shows, 8 of them right after such a round, while their role text and then mark_message's answer said to end with no text. A round
 * with any other call, such as tell_owner, runs on as before. It ends the turn only once an earlier round of the turn answered, so an agent
 * that takes 👀 off before it posts still gets to post.
 */
export async function closingControl(closing: boolean, api: ToolExecutionApi, context: Context): Promise<{ control?: ToolControl }> {
  return closing && (await isCommThread(api, context)) && (await answeredThisTurn(api, context)) ? { control: { terminate: true } } : {};
}

const text = (value: string) => [{ type: "text" as const, text: value }];
const ROOT_ONLY = (name: string) => text(`${name} works only in your agent's own thread, not in a job.`);

/** The two For list tools of one thread, which call apps/chat as that thread; the server maps the thread to its agent. */
export function forMeTools(app: ChatApp, thread: string) {
  return [
    defineTool({
      name: LIST_FOR_ME_TOOL,
      description: LIST_FOR_ME_DESCRIPTION,
      parameters: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed"), Type.Literal("all")], {
          description: "Which items to list: pending (the default), completed or all.",
        })),
      }),
      // A read, so a rerun after a crash reads the list again.
      replay: "safe",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: ROOT_ONLY(LIST_FOR_ME_TOOL), isError: true };
        const status: ForMeFilter = args.status ?? "pending";
        try {
          return { output: text(listText(await app.forMe(thread, status, context.abortSignal), status)) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
    defineTool({
      name: MARK_MESSAGE_TOOL,
      description: MARK_MESSAGE_DESCRIPTION,
      parameters: Type.Object({
        message_id: Type.String({ description: "The item's message id from list_for_me_messages, such as ch_1a2b3c4d/p12 or dm_vent/p41." }),
        completed: Type.Boolean({ description: "true marks it completed, false marks it pending again." }),
      }),
      // The server's mark is idempotent, so a rerun after a crash leaves the same mark.
      replay: "safe",
      execute: async (args, api, context) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: ROOT_ONLY(MARK_MESSAGE_TOOL), isError: true };
        try {
          const answer = await app.markForMe(thread, { messageId: args.message_id, completed: args.completed }, context.abortSignal);
          const closing = answer.item.status === "completed" && answer.pending === 0;
          return { output: text(markedText(answer.item, answer.pending)), ...await closingControl(closing, api, context) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}

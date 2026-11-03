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
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ForMeItem, ForMeList, ForMeStatus, Principal } from "../../../../apps/chat/web/src/lib/api/types.ts";
import type { ChatApp } from "./chat-app.ts";

export const LIST_FOR_ME_TOOL = "list_for_me_messages";
export const MARK_MESSAGE_TOOL = "mark_message";

export type ForMeFilter = ForMeStatus | "all";

export const LIST_FOR_ME_DESCRIPTION =
  "List the messages your agent is involved in, like a person's Slack Activity view: posts in your DM, posts that name you, group posts " +
  "delivered to you, replies in channel threads you posted in, and reactions on your own posts. Each item shows its message id, room, " +
  "author, time, why it is on the list, its reactions, its status and its text.";

export const MARK_MESSAGE_DESCRIPTION =
  "Mark an item of your For list completed once you answered or handled it, or pending again. Marking it the same way twice changes nothing.";

/** The owner as an agent reads him, as in a post's reactions (apps/chat/server/reactions.ts). */
const OWNER_FOR_AGENTS = "Sieun (owner)";
const who = (p: Principal): string => (p.kind === "owner" ? OWNER_FOR_AGENTS : p.name);
const time = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/** An item's reactions in the one form every agent-facing surface shows them: `[reactions: 👀 vent, agent factory · 👍 Sieun (owner)]`. */
export function reactionsText(item: Pick<ForMeItem, "reactions">): string {
  const rows = (item.reactions ?? []).filter(row => row.by.length > 0);
  return rows.length ? `[reactions: ${rows.map(row => `${row.emoji} ${row.by.map(who).join(", ")}`).join(" · ")}]` : "";
}

/** One item as the agent reads it: a header line, its reactions when it has any, then the post's text. */
export function itemText(item: ForMeItem): string {
  const head = [
    `${item.id} in ${item.roomName}${item.threadRoot ? `, thread ${item.threadRoot}` : ""}`,
    `from ${who(item.author)}`,
    item.activityAt !== item.at ? `${time(item.at)}, active ${time(item.activityAt)}` : time(item.at),
    item.reasons.join(", "),
    item.status === "completed" && item.completedAt !== undefined ? `completed ${time(item.completedAt)}` : item.status,
  ].join(" · ");
  const reactions = reactionsText(item);
  return [head, ...(reactions ? [reactions] : []), item.text].join("\n");
}

/** The tool's answer: a count line, then one block per item, newest activity first as the server sorts them. */
export function listText(list: ForMeList, status: ForMeFilter): string {
  const counts = `${list.pending} pending, ${list.completed} completed.`;
  if (list.items.length === 0) return `${counts} No ${status === "all" ? "" : `${status} `}messages.`;
  const shown = status === "all" ? `Showing all ${list.items.length}.` : `Showing the ${list.items.length} ${status}.`;
  return [`${counts} ${shown}`, ...list.items.map(itemText)].join("\n\n");
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
          return { output: text(`Marked ${answer.item.id} ${answer.item.status}. ${answer.pending} pending.`) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}

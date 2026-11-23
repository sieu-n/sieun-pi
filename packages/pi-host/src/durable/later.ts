/**
 * An agent's Saved list, as Slack's saved items and Remind me give a person, through apps/chat's HTTP API (`chat-app.ts`). The chat server
 * keeps the items, keyed by the agent (apps/chat/server/later.ts), and answers each call with the line the tool returns
 * (apps/chat/server/later-agents.ts).
 *
 * `save_message` saves a post with an optional memo, marks it done or takes it off the list, `remind_me` sets or clears a post's reminder, and `list_saved_messages`
 * reads the list. A due reminder wakes the comm thread of the post's room through the board's wake files, with the post and its thread, so an
 * agent can use remind_me to come back to a thread itself. Only the tool text says so; no server rule makes an agent set one (c130, c210).
 *
 * `laterTools` returns the three definitions, which the `room-tools` extension lists beside `set_emoji` (`room-tools.ts`), so a job's child
 * conversation drops them with it.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";

export const SAVE_MESSAGE_TOOL = "save_message";
export const REMIND_ME_TOOL = "remind_me";
export const LIST_SAVED_TOOL = "list_saved_messages";

export const SAVE_MESSAGE_DESCRIPTION =
  "Save a message to your Saved list, as Slack's Save does, mark a saved message done, or take it off your Saved list. A memo keeps your " +
  "own note on why you saved it. Saving it the same way twice changes nothing. A post you saved shows [saved] when you read it. To come " +
  "back to it at a set time, use remind_me.";

export const REMIND_ME_DESCRIPTION =
  "Set a reminder on a message, as Slack's Remind me does, or clear it. The message goes on your Saved list too. When the reminder is due, you " +
  "get a [wake] in this agent's thread for the message's room, with a link to the message and its thread as they read then, and what you " +
  "post in that turn goes in the message's thread. Use it to come back to something yourself, such as to check a thread again in 30 " +
  "minutes or to follow up tomorrow on what you promised. Setting a new time replaces the old one.";

export const LIST_SAVED_DESCRIPTION =
  "List the messages on your Saved list, with each one's room, author, when you saved it, its reminder, your memo and its text. Open lists what is " +
  "still to do, the default, and done lists what you marked done.";

const MESSAGE_ID = Type.String({
  description: "The message: a room-qualified id such as dm_vent/p7 or ch_1a2b3c4d/p12, a post id such as p12 from a room post's header, " +
    "or the [message id: ...] value after an owner message.",
});

/** The body `POST /api/threads/:thread/later` takes: the post, and what to set on the item for it. */
export interface LaterChange {
  message: string;
  state?: "open" | "done" | "removed";
  /** Epoch ms of the reminder, or null to clear it. */
  remindAt?: number | null;
  /** The agent's own note on the saved post; a save with none keeps the one it has. */
  memo?: string;
}

/**
 * When a reminder is due, from remind_me's `in_minutes` or `at`: epoch ms, or an error line for the model. Exactly one is given unless
 * `clear` is set.
 */
export function reminderTime(args: { in_minutes?: number; at?: string; clear?: boolean }, now = Date.now()): number | null | { error: string } {
  if (args.clear) return null;
  if ((args.in_minutes === undefined) === (args.at === undefined)) {
    return { error: "Give in_minutes or at, one of them, or clear: true to remove the reminder." };
  }
  if (args.in_minutes !== undefined) {
    if (!Number.isFinite(args.in_minutes) || args.in_minutes <= 0) return { error: "in_minutes is a number of minutes above 0, such as 30." };
    return Math.round(now + args.in_minutes * 60_000);
  }
  const at = Date.parse(args.at!);
  if (!Number.isFinite(at) || !/(Z|[+-]\d\d:?\d\d)$/i.test(args.at!.trim())) {
    return { error: `${JSON.stringify(args.at)} is no time with a zone; pass ISO 8601 such as 2026-11-21T09:00:00+09:00 or 2026-11-21T00:00:00Z.` };
  }
  if (at <= now) return { error: `${args.at} has passed; pass a later time, or in_minutes.` };
  return at;
}

const text = (value: string) => [{ type: "text" as const, text: value }];
const ROOT_ONLY = (name: string) => text(`${name} works only in your agent's own thread, not in a job.`);

/** The three Later tools of one thread, which call apps/chat as that thread; the server maps the thread to its agent. */
export function laterTools(app: ChatApp, thread: string) {
  const call = async (change: LaterChange, signal: AbortSignal | undefined) => {
    try {
      return { output: text((await app.later(thread, change, signal)).text) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  };
  return [
    defineTool({
      name: SAVE_MESSAGE_TOOL,
      description: SAVE_MESSAGE_DESCRIPTION,
      parameters: Type.Object({
        message_id: MESSAGE_ID,
        state: Type.Optional(Type.Union([Type.Literal("saved"), Type.Literal("done"), Type.Literal("removed")], {
          description: "saved (the default) keeps it on your list, done marks it done and stops its reminder, removed takes it off the list.",
        })),
        memo: Type.Optional(Type.String({
          description: "Your own note on why you saved it or what to do with it, plain text, shown with it in list_saved_messages. A new memo " +
            "replaces the old one; leave it out to keep the old one.",
        })),
      }),
      // The server sets the item to the state given, so a rerun after a crash leaves the same item.
      replay: "safe",
      execute: async (args, api, context) => {
        // A job made before its conversation dropped this extension still lists it, so the call refuses there.
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: ROOT_ONLY(SAVE_MESSAGE_TOOL), isError: true };
        const state = args.state === "done" ? "done" : args.state === "removed" ? "removed" : "open";
        return call({ message: args.message_id, state, ...(state === "open" && args.memo !== undefined ? { memo: args.memo } : {}) }, context.abortSignal);
      },
    }),
    defineTool({
      name: REMIND_ME_TOOL,
      description: REMIND_ME_DESCRIPTION,
      parameters: Type.Object({
        message_id: MESSAGE_ID,
        in_minutes: Type.Optional(Type.Number({ description: "Remind you this many minutes from now, such as 2, 30 or 1440." })),
        at: Type.Optional(Type.String({ description: "Or remind you at this time, ISO 8601 with a zone, such as 2026-11-21T09:00:00+09:00." })),
        clear: Type.Optional(Type.Boolean({ description: "true clears the reminder and keeps the message saved." })),
      }),
      // A rerun of in_minutes sets a time a little later than the first run did, and sets one reminder either way.
      replay: "safe",
      execute: async (args, api, context) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: ROOT_ONLY(REMIND_ME_TOOL), isError: true };
        const remindAt = reminderTime(args);
        if (remindAt !== null && typeof remindAt === "object") return { output: text(remindAt.error), isError: true };
        return call({ message: args.message_id, remindAt }, context.abortSignal);
      },
    }),
    defineTool({
      name: LIST_SAVED_TOOL,
      description: LIST_SAVED_DESCRIPTION,
      parameters: Type.Object({
        state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")], { description: "open (the default) or done." })),
      }),
      // A read, so a rerun after a crash reads the list again.
      replay: "safe",
      execute: async (args, api, context) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: ROOT_ONLY(LIST_SAVED_TOOL), isError: true };
        try {
          return { output: text((await app.laterList(thread, args.state ?? "open", context.abortSignal)).text) };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    }),
  ];
}

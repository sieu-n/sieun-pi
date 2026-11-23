/**
 * Tools an agent uses on the posts of its rooms, through apps/chat's HTTP API (`chat-app.ts`). One extension, `room-tools`, which a thread's
 * root conversation runs when the host loaded Prime's chat extension; a job's child conversation drops it by name (`RoomToolsName`), as it
 * drops the chat's own tools.
 *
 * `set_emoji` puts the agent's reaction on a post or takes it off, as Slack's `reactions.add` and `reactions.remove` do. The comm role text
 * asks the agent to mark the post it works on with 👀, keep it on until that work ends (the result or the checklist's last edit), add no
 * ✅ to a post it replied to, and react the way people do in Slack (`agent-profile.ts` workSteps); no code here treats an emoji specially,
 * as the owner asked on 11-03 (contract: /home/sieun/work/slack-reactions/contract.md). No tool marks a thread done: that check is the
 * owner's alone (p177, c236, "Agent가 Done Check하는 기능 없애").
 *
 * `set_room_member` (`room-members.ts`) adds an agent to a channel or Solo room or removes it.
 *
 * `edit_message` replaces the text of one of the agent's own posts, as Slack's `chat.update` does, through apps/chat's edit of the owner's
 * posts (app.ts `rewrite`): the room shows it with (edited) at once and no new post. An agent fills in results and the answer on its own
 * post instead of a new post per step (owner p106, c207), and never edits in a status of its jobs or plans (c234).
 * An edit that runs long by tell_owner's check is held once with a note, and the same text sent again goes out (`longEdit`, c98).
 * An edit with hand-over words is refused and one with progress words is held once (comm-guard.ts `relayEdit`).
 *
 * `list_for_me_messages` and `mark_message` (`for-me.ts`) read the agent's For list and mark its items, and `save_message`, `remind_me` and
 * `list_saved_messages` (`later.ts`) keep its Later list, and `search_messages` (`search-messages.ts`) runs the owner's Cmd K search with his filters.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type Extension } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";
import { crammedEdit, hasTable, relayEdit } from "./comm-guard.ts";
import { closingControl, forMeTools } from "./for-me.ts";
import { longReply } from "../../../../legacy/prime/user-history/src/shared/reply-lint.ts";
import { ROOM_LONG_WORDS } from "./room-post.ts";
import { laterTools } from "./later.ts";
import { searchTools } from "./search-messages.ts";
import { roomMemberTools } from "./room-members.ts";

export const ROOM_TOOLS_EXTENSION = "room-tools";
export const SET_EMOJI_TOOL = "set_emoji";
export const EDIT_MESSAGE_TOOL = "edit_message";

/** Only the name, so a child conversation drops the extension without the thread it was made for. */
export const RoomToolsName: Extension = defineExtension({ name: ROOM_TOOLS_EXTENSION });

export const SET_EMOJI_DESCRIPTION =
  "Add your emoji reaction to a message, or remove it. Adding a reaction that is already there, or removing one that is not, changes nothing. " +
  "The result names the post and lists its reactions now.";

export const EDIT_MESSAGE_DESCRIPTION =
  "Replace the text of one of your own posts, as Slack's edit does. The post keeps its place, its thread and its reactions, and the room shows " +
  "it with (edited) at once, with no new post and no notification. Use it to correct or complete a post instead of posting again, such as " +
  "filling in each result on a list of findings he asked for, so the last edit carries the answer. An edit adds results and the answer, " +
  "never a status of jobs or plans. You can edit only your own posts. The result names the post, such as p14, so a later edit can use that id.";

export interface EditMessageArgs { message_id: string; text: string }

export const LONG_EDIT_MARK = "Not edited, it runs long";

/**
 * The note for an edit that runs long by tell_owner's check in a room (`longReply`: a sentence over 35 words or over `ROOM_LONG_WORDS` in all, list markers not
 * counted), or undefined when it does not. The same text sent again goes out, so the check is a soft cap (c98). On 11-21 a blind run's work
 * thread grew a checklist over its edits from 54 to 78 to 86 words, as the d4 run of 11-20 saw it grow from 63 to 95, and edit_message had no check.
 */
export function longEdit(edit: string, held: Set<string>): string | undefined {
  if (held.has(edit)) return undefined;
  const long = longReply(edit, ROOM_LONG_WORDS);
  if (!long.length) return undefined;
  held.add(edit);
  return `${LONG_EDIT_MARK}, with ${long.join(" and ")}. Keep the post within ${ROOM_LONG_WORDS} words: the answer on its own line, short ` +
    "items, a nested detail only for a fact its item lacks, and the rest on a wiki page you link. Sending the very same text again edits it as it is (c98).";
}

export const TABLE_EDIT_MARK = "Not edited, it holds a table";

/**
 * The note for an edit whose text holds a markdown table, once, or undefined; the same text sent again edits it (c98). A post with a table is
 * held once (comm-guard.ts), and on 11-22 a blind-reactions run's work thread put a pass and fail table into the result by editing the
 * comm thread's first reply, which no check held.
 */
export function tableEdit(edit: string, held: Set<string>): string | undefined {
  if (held.has(edit) || !hasTable(edit)) return undefined;
  held.add(edit);
  return `${TABLE_EDIT_MARK}, and a room's thread pane cuts a table off. Say the result in a line or a few short bullets, and put a table he ` +
    "must see on a wiki page you link. Sending the very same text again edits it as it is (c98).";
}

export interface SetEmojiArgs { message_id: string; emoji: string; on: boolean }

const text = (value: string) => [{ type: "text" as const, text: value }];

/** Whether a set_emoji call names 👀, by its Slack name or the emoji itself. */
const isEyes = (emoji: string): boolean => ["eyes", ":eyes:", "👀"].includes(emoji.trim());

/** The room tools of one thread, which call apps/chat as that thread. */
export function roomTools(app: ChatApp, thread: string): Extension {
  const heldEdits = new Set<string>();
  const heldCrammed = new Set<string>();
  const heldTables = new Set<string>();
  const heldRelays = new Set<string>();
  return defineExtension({
    name: ROOM_TOOLS_EXTENSION,
    tools: [
      defineTool({
        name: SET_EMOJI_TOOL,
        description: SET_EMOJI_DESCRIPTION,
        parameters: Type.Object({
          message_id: Type.String({
            description: "The message: a room-qualified id such as dm_vent/p7 or ch_1a2b3c4d/p12, a post id such as p12 from a room post's header " +
              "or a room read, or the [message id: ...] value after an owner message.",
          }),
          emoji: Type.String({ description: "The emoji's Slack name, such as eyes, +1 or pray, or the emoji itself." }),
          on: Type.Boolean({ description: "true adds your reaction, false removes it." }),
        }),
        // Both directions are idempotent on the server, so a rerun after a crash leaves the same reactions.
        replay: "safe",
        execute: async (args, api, context) => {
          // A job made before its conversation dropped this extension still lists it, so the call refuses there.
          if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text("set_emoji works only in your agent's own thread, not in a job."), isError: true };
          try {
            const answer = await app.react(thread, { message: args.message_id, emoji: args.emoji, on: args.on }, context.abortSignal);
            return { output: text(answer.text), ...await closingControl(args.on !== isEyes(args.emoji), api, context) };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
          }
        },
      }),
      defineTool({
        name: EDIT_MESSAGE_TOOL,
        description: EDIT_MESSAGE_DESCRIPTION,
        parameters: Type.Object({
          message_id: Type.String({
            description: "Your post: its id such as p14 or a room-qualified id such as dm_vent/p14 or ch_1a2b3c4d/p14; reply:<id> for your first " +
              "post that answers that owner post, such as reply:p12, reply:dm_vent/p12 or reply: with the [message id: ...] after his message; " +
              "or last for your newest post in the room.",
          }),
          text: Type.String({ description: "The whole new text of the post, which replaces the old text." }),
        }),
        // The same text again changes nothing on the server, so a rerun after a crash leaves the same post.
        replay: "safe",
        execute: async (args, api, context) => {
          if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: text("edit_message works only in your agent's own thread, not in a job."), isError: true };
          const relay = relayEdit(args.text.trim(), heldRelays);
          if (relay) return { output: text(relay), isError: true };
          const long = longEdit(args.text.trim(), heldEdits);
          if (long) return { output: text(long), isError: true };
          const crammed = crammedEdit(args.text.trim(), heldCrammed);
          if (crammed) return { output: text(crammed), isError: true };
          const table = tableEdit(args.text.trim(), heldTables);
          if (table) return { output: text(table), isError: true };
          try {
            const answer = await app.editPost(thread, { message: args.message_id, text: args.text }, context.abortSignal);
            return { output: text(answer.text), ...await closingControl(true, api, context) };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            return { output: text(error instanceof Error ? error.message : String(error)), isError: true };
          }
        },
      }),
      ...roomMemberTools(app, thread),
      ...forMeTools(app, thread),
      ...laterTools(app, thread),
      ...searchTools(app),
    ],
  });
}

/**
 * The `send_message` tool: the one way a thread's agent speaks to people. The chat shows each call's text as its own message bubble in a
 * DM and posts it into the channel thread a channel turn came from; everything else the agent writes in its turn is a private working note
 * the chat folds away. The tool itself does nothing outside the thread: its arguments are the message, and its result is "Sent.".
 *
 * Adapted from prime-agent-chat's `tell_owner` (legacy/prime/user-history/src/chat-guard.ts, chat-brief.ts), without its checks: one point
 * per message, no recap on a turn the owner did not start (c117), never "nothing needs you".
 *
 * A thread that runs Prime's chat extension (`prime-chat.ts`) speaks to the owner through Prime's own `tell_owner`, with its guard, as a
 * Prime chat does. There send_message stays as an alias (`SendMessageAlias`, same tool and result, a description that points to
 * tell_owner) for what apps/chat still asks for by this name: a channel post's reply (channels.ts) and a duty job's report (duty-run.ts),
 * which a guard built for the owner's DM would hold. apps/chat draws both tools' calls as the agent's bubbles.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

export const SEND_MESSAGE_TOOL = "send_message";
export const SEND_MESSAGE_RESULT = "Sent.";

export const SEND_MESSAGE_DESCRIPTION =
  "Send one chat message to the people in this conversation: the owner in a DM, or the channel thread a channel post started. This is the " +
  "only way to reach anyone. Everything else you write is a private working note that nobody reads, so never write a final answer as plain text. " +
  "Write like a person in a Slack DM, in the owner's language: the answer first, short, one point per message. Two points are two calls. " +
  "On a turn the owner did not start (a job report, a wake, a check-in, a duty run), send nothing unless a goal he asked for finished, " +
  "a decision or a blocker needs him, or it answers his question. Never send a recap, a status reminder or \"nothing needs you\". " +
  "Use markdown, a table, a mermaid block, links and an embedded image when they carry the content better than prose (config/AGENTS.md rule 5).";

/** send_message beside tell_owner: the same tool for a channel thread's reply or a duty report, and tell_owner for the owner. */
export const SEND_MESSAGE_ALIAS_DESCRIPTION =
  "Post one chat message into the channel thread a channel post started, or send the report a duty job's brief asks for with this tool. " +
  "To speak to the owner in your own chat, call tell_owner instead. Everything else you write is a private working note. " +
  "Write like a person in a Slack thread, in the owner's language: the answer first, short, one point per message. Two points are two calls.";

export interface SendMessageArgs { text: string; to?: string }

const sendMessage = (description: string): Extension => defineExtension({
  name: "send-message",
  tools: [
    defineTool({
      name: SEND_MESSAGE_TOOL,
      description,
      parameters: Type.Object({
        text: Type.String({ description: "The message, as the person reads it." }),
        to: Type.Optional(Type.String({ description: "Only on a turn a channel post started: the channel's name, like #general. Leave it out otherwise." })),
      }),
      // Nothing leaves the thread: the call's arguments are the message, so a rerun after a crash sends nothing twice.
      replay: "safe",
      execute: async () => ({ output: [{ type: "text", text: SEND_MESSAGE_RESULT }] }),
    }),
  ],
});

export const SendMessage: Extension = sendMessage(SEND_MESSAGE_DESCRIPTION);
/** The same extension name, so a subagent's child drops either. */
export const SendMessageAlias: Extension = sendMessage(SEND_MESSAGE_ALIAS_DESCRIPTION);

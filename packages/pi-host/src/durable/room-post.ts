/**
 * Prime's texts on how a message reads, narrowed for a room, so a comm thread gets one rule for what a post looks like: its role text's
 * post steps (`agent-profile.ts` `slackPostStep`). Prime's tell_owner text and its chat brief line on tell_owner say a message is one point
 * in one or two sentences, with no bullets, no colon and one call per point, which suits a Prime chat's DM bubbles. The room rules ask for
 * one post per answer, with a list or a checklist the agent edits when it holds several points (owner p101, p106 in #sw-factory-build).
 * On 11-21 a capture of agent factory's #sw-factory-build comm thread (~/work/prompt-one-to-one/channel-thread) found the two rules in one
 * request, and the owner had written that Prime chat replies felt far more natural (dm_agent-factory, msg mwqt7918). So both Prime texts
 * keep their rules for when to post and drop their rules on shape, and the role text is the one place for shape.
 *
 * Each cut names Prime's exact words and throws when they are gone, so a change of Prime's text fails the tests instead of letting a shape
 * rule back in.
 */
import { CHAT_BRIEF } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { messageIdNote } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import { TELL_OWNER_DESCRIPTION, TELL_OWNER_PARAMETERS } from "../../../../legacy/prime/user-history/src/chat-guard.ts";

/** `text` with the part from `from` up to `to` (not included, or the end when `to` is empty) replaced by `by`. */
function cut(text: string, from: string, to: string, by = ""): string {
  const start = text.indexOf(from);
  const end = to ? text.indexOf(to, start) : text.length;
  if (start < 0 || end < 0) throw new Error(`room-post: Prime's text no longer holds "${start < 0 ? from : to}"`);
  return text.slice(0, start) + by + text.slice(end);
}

/** Where a comm thread reads how a post looks. */
const SHAPE_LINE = "How a post reads, from one short line to a short list or a checklist you edit, is in your role steps.";

/** tell_owner's description in a room: Prime's rules for when to post and why, with its shape rules left to the role text. */
export const ROOM_TELL_OWNER_DESCRIPTION = [
  (text: string) => cut(text, "Send the owner one chat message, its own bubble, like a VP's Slack DM to his CTO. ", "On a turn he started",
    "Post one message to the owner in the room, as a coworker posts in Slack. "),
  (text: string) => cut(text, "A question is its own call", "Any other call there"),
  (text: string) => cut(text, "Write one point, best as one dry", "Use the plain words he would use"),
  (text: string) => cut(text, "Count its sentences and words", "", SHAPE_LINE),
].reduce((text, step) => step(text), TELL_OWNER_DESCRIPTION);

/** tell_owner's parameters in a room: `reply_to` names the post the message answers, which puts it in that post's thread. */
export const ROOM_TELL_OWNER_PARAMETERS = {
  ...TELL_OWNER_PARAMETERS,
  properties: {
    ...TELL_OWNER_PARAMETERS.properties,
    reply_to: {
      type: "string", description: "The [message id] of the post this answers, so it lands in that post's thread. Leave it out for the post " +
        "that started this turn, and set it when you answer an older post or bring a result on a turn he did not start.",
    },
  },
};

/** The chat brief for a comm thread's root: its tell_owner line keeps the rules for when to post and leaves shape to the role text. */
export const COMM_BRIEF: readonly string[] = CHAT_BRIEF.map(line => line.startsWith("Reach the owner only through tell_owner")
  ? cut(line, "Text him like a VP's Slack DM", "On a turn the owner did not start", `${SHAPE_LINE} `)
  : line);

/**
 * A room post's word cap for tell_owner's long check (`longReply`, list markers not counted), above a Prime chat's 80. On 11-21 the owner
 * called agent factory's DM post a model (dm_agent-factory, msg mwqtp2l1, "정말 훌륭한 메시지였어"): an answer line, a short paragraph, a
 * lead-in line, three bullets and a closing line, 92 words, which the 80-word check had held once. Of the 1,315 agent posts in the rooms
 * that day, 32 ran over 80 words and 14 over 120.
 */
export const ROOM_LONG_WORDS = 120;

/** tell_owner's long check in a room: its cap, and a note that says what the role text says. */
export const ROOM_LONG = {
  words: ROOM_LONG_WORDS,
  note: `Keep the post within ${ROOM_LONG_WORDS} words: the answer on its own line, then a few short lines or bullets, and the rest on a wiki ` +
    "page you link. Sending the very same text again sends it as it is (c98).",
};

/** The part of Prime's message id note after the id, which says to set reply_to only after a newer owner message. */
const PRIME_ID_TAIL = messageIdNote(0).slice(messageIdNote(0).indexOf(";"));

/**
 * A message id note in a room: the id alone. Prime's note says to set reply_to only once he sends a newer message, and the room role text
 * says to set it on every result that comes in a later turn, so the two disagreed in every owner input p174's 11-21 captures held.
 */
export function roomIdNote(text: string): string {
  return text.startsWith("[message id: ") && text.endsWith(PRIME_ID_TAIL) ? `${text.slice(0, -PRIME_ID_TAIL.length)}]` : text;
}

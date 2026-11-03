/**
 * Reactions on room posts, as in Slack. The owner adds and removes his own; the chat server puts `WIP_EMOJI` on the post an agent works on
 * and takes it off when the work ends (server/reactions.ts), so no agent ever sets it.
 */

/** The agents' working mark. The owner does not set it himself, so it always means an agent works on the post. */
export const WIP_EMOJI = "⏳";

/** The emoji the owner's reaction picker offers. */
export const QUICK_REACTIONS: readonly string[] = ["👍", "✅", "👀", "🙏", "❤️", "😂", "🎉", "❌"];

/** Whether a string is one emoji: one grapheme with an emoji code point in it. */
export function isEmoji(value: unknown): value is string {
  if (typeof value !== "string" || !/\p{Extended_Pictographic}/u.test(value)) return false;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
}

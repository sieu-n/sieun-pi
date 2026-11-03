/**
 * The owner's Frequently used emoji, as in Slack's picker: each emoji he reacts with counts one use, kept in localStorage. The picker's
 * first row and the message hover bar's one-click emoji read it. Until he has reacted, Slack's own defaults fill it.
 */

const KEY = "chat.emoji.frequent";
const DEFAULTS = ["✅", "👀", "🙌", "👍", "🎉", "❤️", "😂", "🙏", "🔥", "💯", "🚀", "👏", "🤔", "😅", "😭", "😍", "🥲", "❌"];
const SHOWN = 18;

type Uses = Record<string, { count: number; at: number }>;

function load(): Uses {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Uses) : {};
  } catch {
    return {};
  }
}

let uses = $state<Uses>(typeof localStorage === "undefined" ? {} : load());

export const frequentEmoji = {
  /** The most used first, newest use breaking ties, then the defaults he has not used. */
  get list(): string[] {
    const used = Object.entries(uses)
      .sort(([, a], [, b]) => b.count - a.count || b.at - a.at)
      .map(([emoji]) => emoji);
    return [...new Set([...used, ...DEFAULTS])].slice(0, SHOWN);
  },
  use(emoji: string) {
    uses = { ...uses, [emoji]: { count: (uses[emoji]?.count ?? 0) + 1, at: Date.now() } };
    try {
      localStorage.setItem(KEY, JSON.stringify(uses));
    } catch {
      /* A full or blocked storage keeps the count for this tab only. */
    }
  },
};

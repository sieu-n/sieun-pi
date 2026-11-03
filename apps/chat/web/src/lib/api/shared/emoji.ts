/**
 * Emoji by Slack's names (`emoji-data.ts`, generated from emoji-datasource): the picker's categories and search, and the names an agent's
 * `set_emoji` call and a reaction's text use, such as `eyes` for 👀.
 */
import { EMOJI_DATA } from "./emoji-data.ts";

export interface EmojiInfo { char: string; names: readonly string[]; category: string }

export const EMOJI: readonly EmojiInfo[] = EMOJI_DATA.flatMap(([category, lines]) =>
  lines.split("\n").map(line => {
    const space = line.indexOf(" ");
    return { char: line.slice(0, space), names: line.slice(space + 1).split(","), category };
  }));

export const EMOJI_CATEGORIES: readonly string[] = EMOJI_DATA.map(([category]) => category);

const byName = new Map(EMOJI.flatMap(e => e.names.map(name => [name, e] as const)));
const byChar = new Map(EMOJI.map(e => [e.char, e] as const));
const bare = (char: string): string => char.replace(/\uFE0F/g, "");
const byBare = new Map(EMOJI.map(e => [bare(e.char), e] as const));

/** The emoji a Slack name (`eyes`, `:eyes:`) or the emoji itself names, or undefined. */
export function emojiOf(id: string): EmojiInfo | undefined {
  const text = id.trim();
  return byName.get(text.replace(/^:|:$/g, "").toLowerCase()) ?? byChar.get(text) ?? byBare.get(bare(text));
}

/** The Slack name of an emoji (`eyes` for 👀), or undefined for one the table does not know. */
export const emojiName = (char: string): string | undefined => emojiOf(char)?.names[0];

/** The emoji whose names match the query, as Slack's picker searches: names that start with it first, then names that contain it. */
export function searchEmoji(query: string, limit = Infinity): EmojiInfo[] {
  const q = query.trim().replace(/^:|:$/g, "").toLowerCase().replace(/\s+/g, "_");
  if (!q) return [];
  const rank = (e: EmojiInfo): number =>
    e.names.includes(q) ? 0 : e.names.some(n => n.startsWith(q)) ? 1 : e.names.some(n => n.split(/[_-]/).some(part => part.startsWith(q))) ? 2 : e.names.some(n => n.includes(q)) ? 3 : 4;
  const tiers: EmojiInfo[][] = [[], [], [], []];
  for (const e of EMOJI) tiers[rank(e)]?.push(e);
  return tiers.flat().slice(0, limit);
}

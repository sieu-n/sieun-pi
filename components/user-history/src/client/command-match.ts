import type { Command } from "../shared/types.ts";

/**
 * Commands for a "/query" draft, best match first: name prefix (with or without the "skill:" prefix),
 * then a match inside the name, then a match in the description. An empty query lists every command.
 */
export function matchCommands(commands: readonly Command[], query: string, limit = 50): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands.slice(0, limit);
  const ranked: { command: Command; rank: number; order: number }[] = [];
  commands.forEach((command, order) => {
    const name = command.name.toLowerCase();
    const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
    const rank = name.startsWith(needle) || bare.startsWith(needle) ? 0
      : name.includes(needle) ? 1
      : command.description?.toLowerCase().includes(needle) ? 2 : -1;
    if (rank >= 0) ranked.push({ command, rank, order });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, limit).map(entry => entry.command);
}

export interface SlashToken { start: number; end: number; query: string }

/**
 * The "/query" word at the caret: it starts the text or follows whitespace, so "http://a/b" and "a/b" never open the menu.
 * `query` is the text typed between the slash and the caret; `start` to `end` is the whole word, so a pick replaces all of it.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  if (at === start || text[start] !== "/") return null;
  let end = at;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start, end, query: text.slice(start + 1, at) };
}

/** `text` with the slash token replaced by "/name " and the caret placed after that space. */
export function insertSlashCommand(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const tail = text.slice(token.end);
  const inserted = "/" + name + (tail.startsWith(" ") ? "" : " ");
  return { text: text.slice(0, token.start) + inserted + tail, caret: token.start + name.length + 2 };
}

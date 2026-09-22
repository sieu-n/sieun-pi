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

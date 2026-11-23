/**
 * A big read whose bulk is one list of rows by id, asked with `?since=<tag>` of the version the page holds, such as GET /api/skills: the
 * server answers only what changed since then (server/compress.ts `sendKeptJson`). A scan on 11-23 changed 35 of the view's 609 skills,
 * and the page's refresh after it took 1,189 ms at a 200 ms round trip in the p155 rig, since the whole 226 KB came down again.
 */

/**
 * The answer: `same` when the page holds this version; `full` with every entry when the server does not know the page's version; else
 * the rest of the answer, the entries that changed or are new, the ids that went, and the ids in order when the order changed. `rest` is
 * the answer without its list, which the page puts back at its read's path.
 */
export type ListedAnswer =
  | { tag: string; same: true }
  | { tag: string; full: true; rest: Record<string, unknown>; entries: { id: string }[] }
  | { tag: string; rest: Record<string, unknown>; entries: { id: string }[]; removed: string[]; order?: string[] };

/** A version of a listed read as the page keeps it: the answer and the tag it came with. */
export type ListedVersion<T> = { tag: string; value: T };

const listAt = (value: unknown, path: readonly string[]): { id: string }[] | null => {
  let at = value;
  for (const key of path) at = (at as Record<string, unknown> | null)?.[key];
  return Array.isArray(at) ? (at as { id: string }[]) : null;
};

/** `rest` with `list` put back at `path`; a path whose parent is null, such as an inventory not read yet, stays as it is. */
function withList(rest: Record<string, unknown>, path: readonly string[], list: { id: string }[]): Record<string, unknown> {
  const [key, ...deeper] = path;
  if (key === undefined) return rest;
  if (!deeper.length) return { ...rest, [key]: list };
  const inner = rest[key];
  return inner && typeof inner === "object" ? { ...rest, [key]: withList(inner as Record<string, unknown>, deeper, list) } : rest;
}

/**
 * The version an answer makes of the one the page holds, or null when the answer needs a version the page does not hold (`same` or the
 * changes of one it lost), which the page then reads whole.
 */
export function applyListed<T>(held: ListedVersion<T> | null, answer: ListedAnswer, path: readonly string[]): ListedVersion<T> | null {
  if ("same" in answer) return held && held.tag === answer.tag ? held : null;
  if ("full" in answer) return { tag: answer.tag, value: withList(answer.rest, path, answer.entries) as T };
  if (!held) return null;
  const before = listAt(held.value, path) ?? [];
  const byId = new Map(before.map(entry => [entry.id, entry]));
  for (const id of answer.removed) byId.delete(id);
  for (const entry of answer.entries) byId.set(entry.id, entry);
  const ids = answer.order ?? before.map(entry => entry.id).filter(id => byId.has(id));
  const list = ids.flatMap(id => byId.get(id) ?? []);
  return { tag: answer.tag, value: withList(answer.rest, path, list) as T };
}

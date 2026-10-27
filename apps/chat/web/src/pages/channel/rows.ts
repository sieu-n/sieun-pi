/** Buzz groups a run of posts by one author within 5 minutes on one day into one stack. */
export const STACK_MS = 5 * 60_000;

export const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

export type RowSource = { id: string; at: number; kind: string; author?: { id: string } };

export type Row<I extends RowSource> =
  | { kind: "day"; key: string; at: number }
  | { kind: "system"; key: string; item: I }
  | { kind: "post"; key: string; item: I; first: boolean; last: boolean };

/** Lays items, oldest first, out as day dividers, system lines and posts, where `first` shows the byline and `last` the avatar. */
export function layoutRows<I extends RowSource>(items: readonly I[]): Row<I>[] {
  const rows: Row<I>[] = [];
  let previous: I | null = null;
  let lastPost: Extract<Row<I>, { kind: "post" }> | null = null;
  for (const item of items) {
    if (!previous || !sameDay(previous.at, item.at)) {
      rows.push({ kind: "day", key: `day-${item.id}`, at: item.at });
      lastPost = null;
    }
    if (!item.author || item.kind === "system") {
      rows.push({ kind: "system", key: item.id, item });
      lastPost = null;
    } else {
      const joins: boolean = lastPost !== null && lastPost.item.author?.id === item.author.id && item.at - lastPost.item.at < STACK_MS;
      if (joins && lastPost) lastPost.last = false;
      lastPost = { kind: "post", key: item.id, item, first: !joins, last: true };
      rows.push(lastPost);
    }
    previous = item;
  }
  return rows;
}

/** Buzz groups a run of posts by one author within 5 minutes on one day into one stack. */
export const STACK_MS = 5 * 60_000;

export const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

export type RowSource = { id: string; at: number; kind: string; author?: { id: string } };

export type Row<I extends RowSource> =
  | { kind: "day"; key: string; at: number }
  | { kind: "system"; key: string; item: I }
  | { kind: "post"; key: string; item: I; first: boolean; last: boolean };

/**
 * Lays items, oldest first, out as day dividers, system lines and posts, where `first` shows the byline, and the avatar in slack layout, and `last` the avatar in bubble layout.
 * The post after `breakAfter` starts a new group, as a thread's first reply does under its root.
 */
export function layoutRows<I extends RowSource>(items: readonly I[], breakAfter?: string): Row<I>[] {
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
    if (item.id === breakAfter) lastPost = null;
    previous = item;
  }
  return rows;
}

export type DayGroup<I extends RowSource> = { key: string; day: Extract<Row<I>, { kind: "day" }>; rows: Exclude<Row<I>, { kind: "day" }>[] };

/**
 * Rows as one group per day, so a day's divider sticks to the top of the timeline only while that day's rows scroll past, as in Slack. A
 * group's key is its date, so older posts that load into a day join its group instead of drawing the day anew.
 */
export function dayGroups<I extends RowSource>(rows: readonly Row<I>[]): DayGroup<I>[] {
  const groups: DayGroup<I>[] = [];
  for (const row of rows) {
    if (row.kind === "day") groups.push({ key: new Date(row.at).toDateString(), day: row, rows: [] });
    else groups.at(-1)?.rows.push(row);
  }
  return groups;
}

/** The newest `count` rows of the groups, each kept under its day, for the first paint of a long timeline. */
export function newestRows<I extends RowSource>(groups: readonly DayGroup<I>[], count: number): DayGroup<I>[] {
  const kept: DayGroup<I>[] = [];
  let left = count;
  for (let index = groups.length - 1; index >= 0 && left > 0; index--) {
    const group = groups[index]!;
    const rows = group.rows.slice(-left);
    left -= rows.length;
    kept.unshift(rows.length === group.rows.length ? group : { ...group, rows });
  }
  return kept;
}

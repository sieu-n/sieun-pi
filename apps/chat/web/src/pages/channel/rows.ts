/** Buzz groups a run of posts by one author within 5 minutes on one day into one stack. */
export const STACK_MS = 5 * 60_000;

export const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

export type RowSource = { id: string; at: number; kind: string; author?: { id: string }; requestId?: string };

export type Row<I extends RowSource> =
  | { kind: "day"; key: string; at: number }
  | { kind: "system"; key: string; item: I }
  | { kind: "post"; key: string; item: I; first: boolean; last: boolean };

/**
 * Lays items, oldest first, out as day dividers, system lines and posts, where `first` shows the byline, and the avatar in slack layout, and `last` the avatar in bubble layout.
 * The post after `breakAfter` starts a new group, as a thread's first reply does under its root.
 * An owner send keys its row by its requestId, so the stored post that replaces the pending `r:<requestId>` keeps the row the send drew.
 */
export function layoutRows<I extends RowSource>(items: readonly I[], breakAfter?: string): Row<I>[] {
  const rows: Row<I>[] = [];
  const keys = new Set<string>();
  let previous: I | null = null;
  let lastPost: Extract<Row<I>, { kind: "post" }> | null = null;
  for (const item of items) {
    const sendKey = item.requestId ? `r:${item.requestId}` : item.id;
    const key = keys.has(sendKey) ? item.id : sendKey;
    keys.add(key);
    if (!previous || !sameDay(previous.at, item.at)) {
      rows.push({ kind: "day", key: `day-${key}`, at: item.at });
      lastPost = null;
    }
    if (!item.author || item.kind === "system") {
      rows.push({ kind: "system", key, item });
      lastPost = null;
    } else {
      const joins: boolean = lastPost !== null && lastPost.item.author?.id === item.author.id && item.at - lastPost.item.at < STACK_MS;
      if (joins && lastPost) lastPost.last = false;
      lastPost = { kind: "post", key, item, first: !joins, last: true };
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

type DayRow<I extends RowSource> = DayGroup<I>["rows"][number];

function sameRow<I extends RowSource>(a: DayRow<I>, b: DayRow<I>): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.item !== b.item) return false;
  return a.kind === "system" || (b.kind === "post" && a.first === b.first && a.last === b.last);
}

/**
 * `next` with every row and day group that did not change taken from `previous`, so a keyed each skips them and a send redraws its own row
 * instead of every row's props. A send redraws the timeline about four times: the pending send, the stored post's echo, the send's answer
 * and the delivery. On 11-04 in the box Chrome at a box load of 240 to 320, 24 sends in a DM of 90 posts waited p50 166 ms and p90 927 ms
 * with every row redrawn, and p50 90 ms and p90 226 ms with kept rows.
 */
export function keepGroups<I extends RowSource>(previous: readonly DayGroup<I>[], next: DayGroup<I>[]): DayGroup<I>[] {
  const rows = new Map<string, DayRow<I>>();
  const groups = new Map<string, DayGroup<I>>();
  for (const group of previous) {
    groups.set(group.key, group);
    for (const row of group.rows) rows.set(row.key, row);
  }
  return next.map(group => {
    const kept = group.rows.map(row => {
      const old = rows.get(row.key);
      return old && sameRow(old, row) ? old : row;
    });
    const old = groups.get(group.key);
    const dayKept = old && old.day.key === group.day.key && old.day.at === group.day.at;
    if (dayKept && old.rows.length === kept.length && old.rows.every((row, index) => row === kept[index])) return old;
    return { ...group, rows: kept };
  });
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

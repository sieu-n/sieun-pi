import type { SessionSummary } from "prime-agent";

/** A row's place in the index: its box's list (`segment`) times SEGMENT plus its place in that list, so positions sort in list order. */
const SEGMENT = 2 ** 24;
/** Rows a full build looks at between two of its yields, so a sliced build gives the loop a turn (`Catalog.indexInSlices`). */
const BREATHE_ROWS = 256;

/** What one index changed: the row objects it took in and let go, each subagent id's row before it, and whether any subagent row moved. */
export interface IndexChange {
  added: ReadonlySet<SessionSummary>;
  removed: ReadonlySet<SessionSummary>;
  /** A subagent id's row in the index before this change. */
  wasChild: (id: string) => SessionSummary | undefined;
  childrenChanged: boolean;
}

/** A full build's maps, which `adopt` takes in. */
export interface IndexBuild {
  segments: readonly (readonly SessionSummary[])[];
  summaries: Map<string, SessionSummary>; childById: Map<string, SessionSummary>; children: SessionSummary[]; rows: Set<SessionSummary>;
  topAt: Map<string, number[]>; childAt: Map<string, number[]>; childSlot: Map<number, number>;
}

/**
 * The catalog's index of every box's rows: the top-level row of each session id, the subagent row of each subagent id, every subagent row in
 * list order, and every row object. A box's copy hands out its rows as a list whose unchanged rows keep their objects and places, so `update`
 * finds the changed places by identity and indexes those alone. Until 11-04 every index built all of it again from all ~12,500 rows of both
 * boxes, about once per projection: 89 s of the live chat's 1,968 s run from 08:24Z (pid 2551281), and 13% of the projections' own code.
 */
export class SessionIndex {
  summaries = new Map<string, SessionSummary>();
  childById = new Map<string, SessionSummary>();
  children: SessionSummary[] = [];
  rows = new Set<SessionSummary>();
  /** How many rows the last index looked at past the identity check: every row for a build, the changed places for an update. */
  visited = 0;
  private segments: readonly (readonly SessionSummary[])[] = [];
  private topAt = new Map<string, number[]>();
  private childAt = new Map<string, number[]>();
  /** Each subagent row's place in `children`, by its place in the lists. */
  private childSlot = new Map<number, number>();
  private built = false;
  /** Session ids `forget` dropped, placed again by the next update. */
  private readonly forgotten = new Set<string>();

  constructor(private readonly isTop: (row: SessionSummary) => boolean, private readonly duplicate: (row: SessionSummary) => void = () => {}) {}

  get ready(): boolean { return this.built; }

  /** Every row again, yielding every BREATHE_ROWS rows; `adopt` takes the result in. */
  *build(segments: readonly (readonly SessionSummary[])[]): Generator<void, IndexBuild, unknown> {
    const summaries = new Map<string, SessionSummary>();
    const children: SessionSummary[] = [];
    const rows = new Set<SessionSummary>();
    const topAt = new Map<string, number[]>();
    const childAt = new Map<string, number[]>();
    const childSlot = new Map<number, number>();
    let seen = 0;
    for (let segment = 0; segment < segments.length; segment++) {
      const list = segments[segment]!;
      for (let at = 0; at < list.length; at++) {
        if (seen++ % BREATHE_ROWS === 0 && seen > 1) yield;
        const row = list[at]!;
        rows.add(row);
        const place = segment * SEGMENT + at;
        if (!this.isTop(row)) { childSlot.set(place, children.length); children.push(row); push(childAt, row.sessionId, place); continue; }
        push(topAt, row.sessionId, place);
        const existing = summaries.get(row.sessionId);
        // A session on two boxes (a copy, or one moving between them) shows as the box whose daemon runs it, this box's row when both or neither do.
        if (!existing || (row.activeSessionId !== undefined && existing.activeSessionId === undefined)) summaries.set(row.sessionId, row);
        else if (row.activeSessionId !== undefined) this.duplicate(row);
      }
    }
    const childById = new Map<string, SessionSummary>();
    for (let at = 0; at < children.length; at++) {
      if (at % BREATHE_ROWS === 0 && at > 0) yield;
      const row = children[at]!;
      const existing = childById.get(row.sessionId);
      if (!existing || (existing.activeSessionId === undefined && row.activeSessionId !== undefined)) childById.set(row.sessionId, row);
    }
    this.visited = seen;
    return { segments, summaries, childById, children, rows, topAt, childAt, childSlot };
  }

  /** Takes a build in, and what changed against the index before it. */
  adopt(build: IndexBuild): IndexChange {
    const was = this.rows;
    const wasChildren = this.childById;
    const added = new Set<SessionSummary>();
    const removed = new Set<SessionSummary>();
    for (const row of build.rows) if (!was.has(row)) added.add(row);
    for (const row of was) if (!build.rows.has(row)) removed.add(row);
    ({ segments: this.segments, summaries: this.summaries, childById: this.childById, children: this.children, rows: this.rows, topAt: this.topAt, childAt: this.childAt, childSlot: this.childSlot } = build);
    this.forgotten.clear();
    this.built = true;
    return { added, removed, wasChild: id => wasChildren.get(id), childrenChanged: true };
  }

  /** Indexes the places whose row object changed since the last index; null when none did. Needs a build first (`ready`). */
  update(segments: readonly (readonly SessionSummary[])[]): IndexChange | null {
    const changed: { place: number; was: SessionSummary | undefined; now: SessionSummary | undefined }[] = [];
    for (let segment = 0; segment < Math.max(segments.length, this.segments.length); segment++) {
      const before = this.segments[segment] ?? [];
      const after = segments[segment] ?? [];
      if (before === after) continue;
      const length = Math.max(before.length, after.length);
      for (let at = 0; at < length; at++) if (before[at] !== after[at]) changed.push({ place: segment * SEGMENT + at, was: before[at], now: after[at] });
    }
    this.segments = segments;
    this.visited = changed.length;
    if (!changed.length && !this.forgotten.size) return null;
    const wasRows = new Set<SessionSummary>();
    const nowRows = new Set<SessionSummary>();
    const tops = new Set<string>(this.forgotten);
    const kids = new Set<string>();
    let childrenChanged = false;
    // A subagent row that changed in its place keeps its slot in `children`; any other change of a subagent row lists them all again.
    let inPlace = true;
    for (const { place, was, now } of changed) {
      const wasKid = was !== undefined && !this.isTop(was);
      const nowKid = now !== undefined && !this.isTop(now);
      if ((wasKid || nowKid) && !(wasKid && nowKid && this.childSlot.has(place))) inPlace = false;
      if (was) {
        wasRows.add(was);
        if (!wasKid) { drop(this.topAt, was.sessionId, place); tops.add(was.sessionId); }
        else { drop(this.childAt, was.sessionId, place); kids.add(was.sessionId); childrenChanged = true; }
      }
      if (now) {
        nowRows.add(now);
        if (!nowKid) { insert(this.topAt, now.sessionId, place); tops.add(now.sessionId); }
        else { insert(this.childAt, now.sessionId, place); kids.add(now.sessionId); childrenChanged = true; }
      }
    }
    const added = new Set<SessionSummary>();
    const removed = new Set<SessionSummary>();
    for (const row of nowRows) if (!wasRows.has(row) && !this.rows.has(row)) added.add(row);
    for (const row of wasRows) if (!nowRows.has(row)) removed.add(row);
    for (const id of this.forgotten) for (const place of this.topAt.get(id) ?? []) { const row = this.at(place); if (!this.rows.has(row)) added.add(row); }
    this.forgotten.clear();
    for (const row of removed) this.rows.delete(row);
    for (const row of added) this.rows.add(row);
    for (const id of tops) {
      const row = this.winner(this.topAt.get(id), true);
      if (row) this.summaries.set(id, row);
      else this.summaries.delete(id);
    }
    const childWas = new Map<string, SessionSummary | undefined>();
    for (const id of kids) {
      const before = this.childById.get(id);
      const row = this.winner(this.childAt.get(id), false);
      if (row === before) continue;
      childWas.set(id, before);
      if (row) this.childById.set(id, row);
      else this.childById.delete(id);
    }
    if (childrenChanged && inPlace) {
      const children = this.children.slice();
      for (const { place, now } of changed) if (now) children[this.childSlot.get(place)!] = now;
      this.children = children;
    } else if (childrenChanged) {
      const children: SessionSummary[] = [];
      this.childSlot = new Map();
      for (let segment = 0; segment < segments.length; segment++) {
        const list = segments[segment]!;
        for (let at = 0; at < list.length; at++) if (!this.isTop(list[at]!)) { this.childSlot.set(segment * SEGMENT + at, children.length); children.push(list[at]!); }
      }
      this.children = children;
    }
    return { added, removed, wasChild: id => childWas.has(id) ? childWas.get(id) : this.childById.get(id), childrenChanged };
  }

  /** Drops a session's top-level row until the next index places it again (`Catalog.forget`). */
  forget(sessionId: string): void {
    const row = this.summaries.get(sessionId);
    if (row) this.rows.delete(row);
    this.summaries.delete(sessionId);
    this.forgotten.add(sessionId);
  }

  private at(place: number): SessionSummary { return this.segments[Math.floor(place / SEGMENT)]![place % SEGMENT]!; }

  /** The first row in list order, or the first with a worker when the first has none, as `build` picks it. */
  private winner(places: readonly number[] | undefined, top: boolean): SessionSummary | undefined {
    let existing: SessionSummary | undefined;
    for (const place of places ?? []) {
      const row = this.at(place);
      if (!existing || (row.activeSessionId !== undefined && existing.activeSessionId === undefined)) existing = row;
      else if (top && row.activeSessionId !== undefined) this.duplicate(row);
    }
    return existing;
  }
}

function push(map: Map<string, number[]>, id: string, place: number): void {
  const places = map.get(id);
  if (places) places.push(place);
  else map.set(id, [place]);
}

function insert(map: Map<string, number[]>, id: string, place: number): void {
  const places = map.get(id);
  if (!places) { map.set(id, [place]); return; }
  let at = places.length;
  while (at > 0 && places[at - 1]! > place) at--;
  if (places[at - 1] !== place) places.splice(at, 0, place);
}

function drop(map: Map<string, number[]>, id: string, place: number): void {
  const places = map.get(id);
  if (!places) return;
  const at = places.indexOf(place);
  if (at >= 0) places.splice(at, 1);
  if (!places.length) map.delete(id);
}

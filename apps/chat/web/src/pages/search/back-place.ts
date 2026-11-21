/**
 * Back to the results page returns to the cards, the picked card and the scroll spot he left, as Slack does. What the page showed is kept
 * per history entry, under an id in that entry's `history.state`, so a fresh search from Cmd K or the field gets a new entry and a fresh
 * read, and only Back or Forward to an entry finds its place again. The places live in memory, so a reload reads the results anew.
 */
import type { SearchHit, SearchMissing } from "$lib/api";
import type { HitContext } from "./context";

export type Place = {
  /** The search the entry showed (results-model.ts `searchParams`), so an entry's place never fills another search. */
  key: string;
  hits: SearchHit[];
  total: number;
  missing: SearchMissing[];
  cursor: string | undefined;
  focusedIndex: number;
  scrollTop: number;
  expanded: string[];
  contexts: [string, HitContext | "error"][];
};

const STATE_KEY = "searchPlace";
const places = new Map<string, Place>();
let made = 0;

const stateOf = (): Record<string, unknown> => (history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {});

/** The id of the history entry open now, given to it on first use. */
export function entryId(): string {
  const state = stateOf();
  const id = state[STATE_KEY];
  if (typeof id === "string") return id;
  const fresh = `${Date.now().toString(36)}-${++made}`;
  history.replaceState({ ...state, [STATE_KEY]: fresh }, "");
  return fresh;
}

export function placeOf(entry: string, key: string): Place | undefined {
  const place = places.get(entry);
  return place?.key === key ? place : undefined;
}

export function keepPlace(entry: string, place: Place): void {
  places.set(entry, place);
}

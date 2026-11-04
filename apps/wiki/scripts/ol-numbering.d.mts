// Types for ol-numbering.mjs, for the same reason as dup-held.d.mts.

/** Each top-level <ol> of the page in order, with the span of its open tag, its start= and its count of direct items. */
export function topLists(html: string): { at: number; tag: string; start: number; count: number }[];

/** The (expected, actual) start of each top-level list that does not run on from the list before it. */
export function numberBreaks(html: string): [number, number][];

/** The page with its top-level lists numbered on in order and its "item N" references moved with their lines. */
export function renumberLists(html: string): { html: string; moved: number; ambiguous: number[] };

/**
 * Whether this page runs an older web build than the chat server serves now. The server names its build by the entry script of its
 * index.html (server/web-entry.ts), and the page reads the same tag from its own document, so a release that ships a new bundle tells
 * every open tab. On 11-04 a tab loaded the day before sent images in a shape the server had dropped, and two posts were Not delivered.
 */

/** True when both builds are known and differ; a dev server or a missing index.html says nothing. */
export function isStale(served: string | null | undefined, mine: string | null | undefined): boolean {
  return !!served && !!mine && served !== mine;
}

/** The entry script this page loaded, as its index.html named it. */
export function pageEntry(doc: Pick<Document, "querySelector"> = document): string | null {
  return doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
}

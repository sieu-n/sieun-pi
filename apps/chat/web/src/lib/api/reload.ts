/**
 * Reloads a page that runs an older web build than the server at a moment when nothing is lost: the tab is hidden or out of focus, no
 * send is on its way, and nothing waits that only this page holds, such as an attached image not sent yet or a Not delivered send whose
 * image never uploaded. Typed drafts stay in localStorage (Composer) and kept sends in held-sends.ts, so the next page shows both. On 11-04
 * a tab loaded before b2058046 sent images in a shape the new server refused, and the owner's post came back Not delivered.
 */

const holds = new Set<string>();
let wanted = false;

/** Something only this page holds; the page does not reload until it is released. */
export function holdReload(key: string): void {
  holds.add(key);
}

export function releaseReload(key: string): void {
  if (holds.delete(key)) tryReload();
}

/** The page is stale: reload at the first safe moment, now or when the tab is next hidden or loses focus. */
export function reloadWhenSafe(): void {
  if (wanted || typeof window === "undefined") return;
  wanted = true;
  document.addEventListener("visibilitychange", tryReload);
  window.addEventListener("blur", tryReload);
  tryReload();
}

function tryReload(): void {
  if (!wanted || holds.size || (!document.hidden && document.hasFocus())) return;
  location.reload();
}

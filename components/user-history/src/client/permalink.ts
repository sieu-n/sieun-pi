/**
 * The page hash names what is open: `#<sessionId>` a thread, `#<sessionId>@<ms>` one message in it (the message's `timestamp`). The thread view
 * scrolls to that message and flashes it. Threads and chats share the form, so a board link or a copied link opens either.
 */
export interface HashTarget { id: string; at: number | null }

export function parseHash(hash: string): HashTarget | null {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  if (!raw) return null;
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { id: raw, at: null };
  const stamp = Number(raw.slice(at + 1));
  return /^\d+$/.test(raw.slice(at + 1)) && Number.isSafeInteger(stamp) ? { id: raw.slice(0, at), at: stamp } : { id: raw, at: null };
}

export function hashFor(id: string, at: number | null = null): string {
  return "#" + encodeURIComponent(id) + (at === null ? "" : "@" + at);
}

/** The full page URL for a message, the one Copy link puts on the clipboard. */
export function permalink(id: string, at: number, page: { origin: string; pathname: string; search: string } = location): string {
  return page.origin + page.pathname + page.search + hashFor(id, at);
}

/**
 * Which message a link lands on: the one with that exact `timestamp`, else the nearest in time (the earlier one on a tie). A link copied
 * from a job drawer carries the time the chat received the report, and the job's own reply sits a moment before or after it.
 */
export function anchorStamp(stamps: readonly number[], at: number): number | null {
  let best: number | null = null;
  for (const stamp of stamps) {
    if (best === null || Math.abs(stamp - at) < Math.abs(best - at) || (Math.abs(stamp - at) === Math.abs(best - at) && stamp < best)) best = stamp;
  }
  return best;
}

/** Scrolls `root` to the message a link names (elements carry `data-at`) and flashes it for 2 s. False when the root has no messages before `at`. */
export function revealMessage(root: HTMLElement, at: number): boolean {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-at]")];
  const stamp = anchorStamp(nodes.map(node => Number(node.dataset.at)), at);
  const target = stamp === null ? null : nodes.find(node => Number(node.dataset.at) === stamp);
  if (!target) return false;
  target.style.scrollMarginTop = "12px";
  target.scrollIntoView({ block: target.offsetHeight > root.clientHeight * 0.8 ? "start" : "center" });
  target.classList.add("linked");
  setTimeout(() => target.classList.remove("linked"), 2000);
  return true;
}

export async function copyPermalink(id: string, at: number): Promise<boolean> {
  try { await navigator.clipboard.writeText(permalink(id, at)); return true; } catch { return false; }
}

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

/**
 * What a page URL opens: its hash, else `?t=<id>`. The client keeps `?t=` on the open thread (`searchFor`), because the server never sees the
 * hash, and with it the page shell carries the thread's first page inline (chat-server.ts shellTail).
 */
export function pageTarget(page: { hash: string; search: string } = location): HashTarget | null {
  const named = new URLSearchParams(page.search).get("t");
  return parseHash(page.hash) ?? (named ? { id: named, at: null } : null);
}

/** `search` with `?t=` set to the thread `id`, or without it for none. */
export function searchFor(id: string | null, search = ""): string {
  const params = new URLSearchParams(search);
  if (id) params.set("t", id); else params.delete("t");
  const text = params.toString();
  return text ? "?" + text : "";
}

export function hashFor(id: string, at: number | null = null): string {
  return "#" + encodeURIComponent(id) + (at === null ? "" : "@" + at);
}

/** The full page URL for a message, the one Copy link puts on the clipboard. */
export function permalink(id: string, at: number, page: { origin: string; pathname: string; search: string } = location): string {
  return page.origin + page.pathname + searchFor(id, page.search) + hashFor(id, at);
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
  return reveal(root, stamp === null ? null : nodes.find(node => Number(node.dataset.at) === stamp));
}

/** Scrolls `root` to the feed line with that id (elements carry `data-line`) and flashes it for 2 s. False when the feed does not show it. */
export function revealLine(root: HTMLElement, line: string): boolean {
  return reveal(root, [...root.querySelectorAll<HTMLElement>("[data-line]")].find(node => node.dataset.line === line));
}

function reveal(root: HTMLElement, target: HTMLElement | null | undefined): boolean {
  if (!target) return false;
  target.style.scrollMarginTop = "12px";
  const place = () => target.scrollIntoView({ block: target.offsetHeight > root.clientHeight * 0.8 ? "start" : "center" });
  place();
  settle(root, target, place);
  clearTimeout(flashes.get(target));
  target.classList.remove("linked");
  void target.offsetWidth;
  target.classList.add("linked");
  flashes.set(target, setTimeout(() => target.classList.remove("linked"), 2000));
  return true;
}
/**
 * Places the message again on each frame until it holds still for two frames, and stops at once when the owner scrolls. A turn off screen lays
 * out at a guessed height (Turn.svelte `content-visibility`) and takes its real one once the scroll brings it near, which pushed a linked message
 * under the composer: on 10-28 a jump to line 20 of a 40-message thread grew the scroller from 3213 to 3925 px in the next frame.
 */
function settle(root: HTMLElement, target: HTMLElement, place: () => void): void {
  const INPUTS = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
  let stopped = false;
  const stop = () => { stopped = true; for (const type of INPUTS) root.removeEventListener(type, stop); };
  for (const type of INPUTS) root.addEventListener(type, stop, { passive: true });
  let last = target.getBoundingClientRect().top;
  let still = 0;
  const step = () => {
    if (stopped || !target.isConnected) { stop(); return; }
    const top = target.getBoundingClientRect().top;
    if (Math.abs(top - last) < 1) still += 1;
    else { still = 0; place(); last = target.getBoundingClientRect().top; }
    if (still >= 2) stop(); else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The pending end of each element's flash, so a second reveal of the same message restarts it in full. */
const flashes = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export async function copyPermalink(id: string, at: number): Promise<boolean> {
  try { await navigator.clipboard.writeText(permalink(id, at)); return true; } catch { return false; }
}

/**
 * When a page that sees a restart onto new client code reloads. A reload in view blanks the page, drops its scroll and shows a spinner until the
 * open chat's snapshot comes back, so a page in view waits until the owner leaves it (another tab, app or window) and reloads then, unseen. On
 * 10-18 the chat restarted 42 times by 06:15Z, mostly for releases, and every page in view reloaded each time.
 *
 * A busy page (a chat being created, or a send whose POST has not answered) waits until it is idle and plans again, because a reload then would
 * drop the request. Unsent drafts no longer hold a page back: the page saves them for the reload (see `saveDrafts`). Until 10-18 a page with a
 * draft only offered Reload, once, and never planned again, so the owner's chat window loaded at 06:36Z still ran that code at 11:00Z, with
 * one renderer at 160% CPU and 2.4 GB, through every release since, including the idle-animation fix faa58cd5a.
 */
export type BuildReload = "now" | "on-leave" | "wait";

export function buildReload(page: { hidden: boolean; focused: boolean; busy: boolean }): BuildReload {
  if (page.busy) return "wait";
  return page.hidden || !page.focused ? "now" : "on-leave";
}

/** Runs `reload` once, the first time the page goes hidden or loses focus. */
export function onLeave(reload: () => void): void {
  let done = false;
  const leave = () => {
    if (done || (document.visibilityState === "visible" && document.hasFocus())) return;
    done = true;
    reload();
  };
  document.addEventListener("visibilitychange", leave);
  window.addEventListener("blur", leave);
}

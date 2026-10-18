/**
 * When a page that sees a restart onto new client code reloads. A reload in view blanks the page, drops its scroll and shows a spinner until the
 * open chat's snapshot comes back, so a page in view waits until the owner leaves it (another tab, app or window) and reloads then, unseen. On
 * 10-18 the chat restarted 42 times by 06:15Z, mostly for releases, and every page in view reloaded each time. A page with an unsent draft or a
 * starting chat offers the reload instead, as before.
 */
export type BuildReload = "now" | "on-leave" | "offer";

export function buildReload(page: { hidden: boolean; focused: boolean; unsent: boolean }): BuildReload {
  if (page.unsent) return "offer";
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

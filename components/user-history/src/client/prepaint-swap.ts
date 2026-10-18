/**
 * The app takes over from the still view the shell painted before app.js arrived (src/prepaint.ts). The still view covers the page until the
 * app shows what it stood for: the chat's lines, its empty or error state, or another view than a chat. It goes on the next frame, after the
 * chat's own first scroll to the bottom, so the page never shows both and never an empty feed.
 */
export const SHOWN = ".chat .column .line, .chat .column .empty, .chat .error-card, main > :not(.chat)";

export function takeOver(prepaint: Element, app: Element, frame: (run: () => void) => void = requestAnimationFrame): void {
  const observer = new MutationObserver(() => { shown(); });
  function shown(): boolean {
    if (!app.querySelector(SHOWN)) return false;
    observer.disconnect();
    frame(() => { prepaint.remove(); delete document.documentElement.dataset.prepaintBoard; });
    return true;
  }
  if (!shown()) observer.observe(app, { childList: true, subtree: true });
}

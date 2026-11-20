/**
 * Focus rings show only after keyboard use: a Tab or arrow key sets html[data-keyboard-navigation],
 * and a pointer press clears it. Call once at startup.
 */
export function trackKeyboardNavigation(): void {
  const root = document.documentElement;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) root.dataset.keyboardNavigation = "";
    },
    true,
  );
  window.addEventListener("pointerdown", () => delete root.dataset.keyboardNavigation, true);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * True while an IME such as Korean composes text, so an Enter keydown confirms a syllable and must not send, save or pick. WebKit can
 * deliver that Enter after compositionend with isComposing false (WebKit bug 165004), and sw factory renders in WKWebView on the Mac, so
 * keyCode 229, which a keydown reports while an IME takes the key, counts too.
 */
export function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** True for Cmd on a Mac and Ctrl elsewhere. */
export function modKey(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

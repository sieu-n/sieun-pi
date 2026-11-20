/** True inside apps/desktop, the Mac app, because Tauri adds `__TAURI_INTERNALS__` to every page it shows. */
export const inDesktopShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Marks the root, so CSS outside TopBar, such as Dialog's room for the window buttons, can follow the Mac app. */
if (inDesktopShell) document.documentElement.dataset.shell = "desktop";

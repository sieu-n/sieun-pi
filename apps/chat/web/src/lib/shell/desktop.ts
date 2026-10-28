/** True inside apps/desktop, the Mac app, because Tauri adds `__TAURI_INTERNALS__` to every page it shows. */
export const inDesktopShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

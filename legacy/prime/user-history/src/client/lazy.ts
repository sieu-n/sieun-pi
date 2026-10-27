/**
 * The views a page opens only on a click, each in a chunk of its own (`splitting` in chat-assets.ts `compileClient`), so a cold load fetches
 * and runs less before the chat shows. On 10-19 app.js was 697 KB raw and 197 KB brotli, and from the Mac (195 ms a round trip) it ended 0.4 to
 * 0.8 s after the shell. Each loader runs its import once; `warmLazy` fetches them all once the page is idle, so the first click finds them in
 * the module map.
 */
const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loaded: Promise<T> | undefined;
  return () => loaded ??= load().catch(error => { loaded = undefined; throw error; });
};

export const lazy = {
  Settings: once(() => import("./Settings.svelte")),
  AgentsDialog: once(() => import("./AgentsDialog.svelte")),
  Reader: once(() => import("./Reader.svelte")),
  PromptView: once(() => import("./PromptView.svelte")),
  PlanView: once(() => import("./PlanView.svelte")),
  JobDrawer: once(() => import("./JobDrawer.svelte")),
  SearchPanel: once(() => import("./SearchPanel.svelte")),
};

/** Fetches every lazy view a few seconds after the first paint, when the page's own frames are in. */
export function warmLazy(delayMs = 3000): void {
  setTimeout(() => { for (const load of Object.values(lazy)) void load().catch(() => {}); }, delayMs);
}

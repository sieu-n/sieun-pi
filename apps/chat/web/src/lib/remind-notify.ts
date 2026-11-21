/**
 * System notifications, the Dock badge and the window title, for due reminders and new messages. In a browser tab a notification is the Web
 * Notification API; in apps/desktop it is Tauri's notification plugin, because the Mac app's WKWebView has no `Notification`. The browser
 * asks for the permission from a click: his first reminder, or Turn on in the notices toast (notices.svelte.ts).
 */
import { notifyPermission } from "./notify-prefs.svelte";
import { inDesktopShell } from "./shell/desktop";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauri(): Invoke | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return inDesktopShell && typeof internals?.invoke === "function" ? internals.invoke : null;
}

/**
 * Runs `fire` in one open tab only: the tab that gets the Web Lock `key` first, so three open tabs make one notification. It holds the lock
 * past the other tabs' copies of the event, which come within a frame of this one.
 */
export function notifyOnce(key: string, fire: () => void): void {
  if (!navigator.locks) return fire();
  void navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock) return;
    fire();
    await new Promise(resolve => setTimeout(resolve, 5000));
  });
}

/** Reads whether notifications may show into `notifyPermission`. */
export async function readNotifyPermission(): Promise<void> {
  const invoke = tauri();
  try {
    if (invoke) notifyPermission.value = (await invoke("plugin:notification|is_permission_granted")) ? "granted" : "default";
    else notifyPermission.value = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    // A Mac app built before the notification plugin refuses the command.
    notifyPermission.value = "unsupported";
  }
}

/** Asks for the permission once, from a click; a no-op once granted or denied. */
export async function askNotifyPermission(): Promise<void> {
  const invoke = tauri();
  try {
    if (invoke) {
      if (!(await invoke("plugin:notification|is_permission_granted"))) await invoke("plugin:notification|request_permission");
    } else if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
  } catch {
    // A Mac app built before the notification plugin refuses the command; the in-app toast still shows the reminder.
  }
  await readNotifyPermission();
}

/**
 * Puts `count` on the Mac app's Dock icon, or clears it at 0. A browser tab sets the app badge of an installed web app, where Chrome has
 * one. A Mac app built before its capability allowed `set_badge_count` refuses the call, and the window title still carries the count.
 */
export function setDockBadge(count: number): void {
  const invoke = tauri();
  if (invoke) {
    void invoke("plugin:window|set_badge_count", { label: "main", value: count > 0 ? count : null }).catch(() => {});
    return;
  }
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
}

/** Names the Mac app's window, which Mission Control, the Window menu and Cmd+` show; a browser tab's title is `document.title`. */
export function setWindowTitle(title: string): void {
  void tauri()?.("plugin:window|set_title", { label: "main", value: title }).catch(() => {});
}

/** Shows the system notification; `onclick` runs when the owner clicks it in a browser (the Mac app brings its window up by itself). */
export async function notifySystem(title: string, body: string, tag: string, onclick: () => void): Promise<boolean> {
  const invoke = tauri();
  try {
    if (invoke) {
      if (!(await invoke("plugin:notification|is_permission_granted"))) return false;
      await invoke("plugin:notification|notify", { options: { title, body } });
      return true;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    const note = new Notification(title, { body, tag });
    note.onclick = () => {
      window.focus();
      onclick();
      note.close();
    };
    return true;
  } catch {
    return false;
  }
}

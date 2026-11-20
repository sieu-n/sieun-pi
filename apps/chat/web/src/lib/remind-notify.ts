/**
 * The system notification of a due reminder. In a browser tab it is the Web Notification API; in apps/desktop it is Tauri's notification
 * plugin, because the Mac app's WKWebView has no `Notification`. The owner grants the permission when he sets his first reminder, which is
 * the click the browser asks a permission prompt to come from.
 */
import { inDesktopShell } from "./shell/desktop";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauri(): Invoke | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return inDesktopShell && typeof internals?.invoke === "function" ? internals.invoke : null;
}

/** Asks for the permission once, from a click; a no-op once granted or denied. */
export async function askNotifyPermission(): Promise<void> {
  const invoke = tauri();
  try {
    if (invoke) {
      if (!(await invoke("plugin:notification|is_permission_granted"))) await invoke("plugin:notification|request_permission");
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
  } catch {
    // A Mac app built before the notification plugin refuses the command; the in-app toast still shows the reminder.
  }
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

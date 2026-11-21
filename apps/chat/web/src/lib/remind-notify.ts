/**
 * System notifications, the Dock badge and the window title, for due reminders and new messages. In a browser tab a notification is the Web
 * Notification API; in apps/desktop it is Tauri's notification plugin, because the Mac app's WKWebView has no `Notification`. The browser
 * asks for the permission from a click: his first reminder, or Turn on in the notices toast (notices.svelte.ts).
 */
import { notifyPermission } from "./notify-prefs.svelte";
import { inDesktopShell } from "./shell/desktop";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Internals = { invoke?: Invoke; transformCallback?: (callback: (raw: unknown) => void, once?: boolean) => number };

function internals(): Internals | undefined {
  return inDesktopShell ? (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__ : undefined;
}

function tauri(): Invoke | null {
  const invoke = internals()?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

/** A button of a Mac app notification. macOS puts two or more in an Options menu, and a click on Options itself picks the first. */
export type NotifyAction = { id: string; title: string };
/** What a notification of an action type carries back when he clicks it (`tap`) or one of its buttons. */
type ActionHandler = (actionId: string, extra: Record<string, unknown>) => void;
const actionHandlers = new Map<string, ActionHandler>();
let listening = false;

/**
 * Gives the Mac app's notifications of action type `type` the buttons `actions`, and runs `handler` on a click on one of them or on the
 * notification itself (`tap`). tauri-plugin-notification 2.6 and later reports these on desktop, and only for notifications shown while a
 * listener exists, so the page registers at start. A browser tab has no notification buttons, and a Mac app built before 2.6 refuses the
 * commands; both show the notification without buttons.
 */
export async function onNotifyAction(type: string, actions: NotifyAction[], handler: ActionHandler): Promise<void> {
  actionHandlers.set(type, handler);
  const shell = internals();
  const invoke = tauri();
  if (!invoke || typeof shell?.transformCallback !== "function") return;
  try {
    await invoke("plugin:notification|register_action_types", { types: [{ id: type, actions }] });
    if (listening) return;
    listening = true;
    // The plugin's Channel: Rust sends `{message, index}` to this callback id, and `{end}` when it drops the listener.
    const channel = shell.transformCallback((raw) => {
      const message = (raw as { message?: { actionId?: unknown; notification?: { actionTypeId?: unknown; extra?: unknown } | null } }).message;
      if (typeof message?.actionId !== "string") return;
      const run = actionHandlers.get(String(message.notification?.actionTypeId ?? ""));
      run?.(message.actionId, (message.notification?.extra ?? {}) as Record<string, unknown>);
    });
    await invoke("plugin:notification|register_listener", { event: "actionPerformed", handler: `__CHANNEL__:${channel}` });
  } catch {
    listening = false;
  }
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

/**
 * Shows the system notification; `onclick` runs when the owner clicks it in a browser (the Mac app brings its window up by itself). In the
 * Mac app, `action` names an action type registered with `onNotifyAction`, whose buttons it shows and whose handler gets `extra` back.
 */
export async function notifySystem(title: string, body: string, tag: string, onclick: () => void, action?: { type: string; extra: Record<string, unknown> }): Promise<boolean> {
  const invoke = tauri();
  try {
    if (invoke) {
      if (!(await invoke("plugin:notification|is_permission_granted"))) return false;
      await invoke("plugin:notification|notify", { options: { title, body, ...(action ? { actionTypeId: action.type, extra: action.extra } : {}) } });
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

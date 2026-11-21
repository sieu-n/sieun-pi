import { isMac, modKey } from "$lib/ui/keyboard";

/**
 * The one table of the app's keyboard shortcuts. The Cmd+/ sheet (lib/shell/ShortcutsSheet.svelte), Settings > Keyboard and the tooltips
 * read their keys from here, and App.svelte runs the global ones through `matches`. A key handled inside one view, such as U in the
 * timeline, is listed here with `scope` naming that view, so the sheet shows it, while its own component keeps the handler.
 *
 * Keys are platform-free: "mod" is Cmd on a Mac and Ctrl elsewhere, and a key is a `KeyboardEvent.key` in lower case.
 */
export type Key = "mod" | "shift" | "alt" | (string & {});
export type Keys = readonly Key[];

export type Shortcut = {
  readonly id: string;
  readonly label: string;
  readonly keys: Keys;
  /** More keys that do the same, matched but not shown, such as Cmd+? beside Cmd+/. */
  readonly also?: readonly Keys[];
  /** Where the key works when it is not everywhere, such as "on a hovered message". */
  readonly scope?: string;
};

export type ShortcutGroup = { readonly id: string; readonly label: string; readonly shortcuts: readonly Shortcut[] };

export const SHORTCUT_GROUPS = [
  {
    id: "navigate",
    label: "Navigation",
    shortcuts: [
      { id: "search", label: "Search", keys: ["mod", "k"] },
      { id: "prev-conversation", label: "Previous conversation", keys: ["alt", "arrowup"] },
      { id: "next-conversation", label: "Next conversation", keys: ["alt", "arrowdown"] },
      { id: "prev-unread", label: "Previous unread conversation", keys: ["alt", "shift", "arrowup"] },
      { id: "next-unread", label: "Next unread conversation", keys: ["alt", "shift", "arrowdown"] },
      { id: "dms", label: "Direct messages", keys: ["mod", "shift", "k"] },
      { id: "for-you", label: "For you", keys: ["mod", "shift", "m"] },
      { id: "later", label: "Later", keys: ["mod", "shift", "s"] },
      { id: "all-unreads", label: "All unreads", keys: ["mod", "shift", "a"] },
      { id: "messages", label: "Messages", keys: ["mod", "1"] },
      { id: "agents", label: "Agents", keys: ["mod", "2"] },
      { id: "board", label: "Board", keys: ["mod", "3"] },
      { id: "settings", label: "Settings", keys: ["mod", ","] },
      { id: "back", label: "Back", keys: ["mod", "["] },
      { id: "forward", label: "Forward", keys: ["mod", "]"] },
    ],
  },
  {
    id: "messages",
    label: "Messages",
    shortcuts: [
      { id: "new-dm", label: "New message", keys: ["mod", "n"] },
      { id: "focus-composer", label: "Jump to the message box", keys: ["mod", "l"], scope: "in a conversation" },
      { id: "send", label: "Send", keys: ["enter"], scope: "in the message box" },
      { id: "newline", label: "New line", keys: ["shift", "enter"], scope: "in the message box" },
      { id: "edit-last", label: "Edit your last message", keys: ["arrowup"], scope: "in an empty message box" },
      { id: "mark-unread", label: "Mark unread", keys: ["u"], scope: "on a hovered message" },
      { id: "pin", label: "Pin or un-pin", keys: ["p"], scope: "on a hovered message" },
      { id: "mark-read", label: "Mark the conversation read", keys: ["escape"], scope: "in a conversation with new messages" },
      { id: "mark-all-read", label: "Mark all as read", keys: ["shift", "escape"] },
    ],
  },
  {
    id: "view",
    label: "View",
    shortcuts: [
      { id: "sidebar", label: "Show or hide the sidebar", keys: ["mod", "shift", "d"] },
      { id: "zoom-in", label: "Zoom in", keys: ["mod", "="], also: [["mod", "+"], ["mod", "shift", "+"]] },
      { id: "zoom-out", label: "Zoom out", keys: ["mod", "-"] },
      { id: "zoom-reset", label: "Actual size", keys: ["mod", "0"] },
      { id: "shortcuts", label: "Keyboard shortcuts", keys: ["mod", "/"], also: [["mod", "shift", "?"]] },
    ],
  },
] as const satisfies readonly ShortcutGroup[];

export type ShortcutId = (typeof SHORTCUT_GROUPS)[number]["shortcuts"][number]["id"];

const byId = new Map<string, Shortcut>(SHORTCUT_GROUPS.flatMap((g): readonly Shortcut[] => g.shortcuts).map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  return byId.get(id)!;
}

const MAC: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", arrowup: "↑", arrowdown: "↓", enter: "↩" };
const OTHER: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", arrowup: "↑", arrowdown: "↓", enter: "Enter" };

/** Each key's label in order, ⌘ ⇧ K on a Mac and Ctrl Shift K elsewhere, for a row of <kbd>. */
export function keyCaps(keys: Keys, mac = isMac): string[] {
  const names = mac ? MAC : OTHER;
  return keys.map((k) => names[k] ?? k.toUpperCase());
}

/** One string for a tooltip or a menu: ⌘⇧K on a Mac, Ctrl Shift K elsewhere. */
export function formatKeys(keys: Keys, mac = isMac): string {
  return keyCaps(keys, mac).join(mac ? "" : " ");
}

export function shortcutLabel(id: ShortcutId): string {
  return formatKeys(shortcut(id).keys);
}

function matchesKeys(e: KeyboardEvent, keys: Keys): boolean {
  const key = keys[keys.length - 1];
  return (
    keys.includes("mod") === modKey(e) &&
    keys.includes("shift") === e.shiftKey &&
    keys.includes("alt") === e.altKey &&
    (isMac ? !e.ctrlKey : !e.metaKey) &&
    e.key.toLowerCase() === key
  );
}

/** True when the event is this shortcut's keys or one of its `also` keys, with no other modifier held. */
export function matches(e: KeyboardEvent, s: Shortcut): boolean {
  return matchesKeys(e, s.keys) || (s.also ?? []).some((keys) => matchesKeys(e, keys));
}

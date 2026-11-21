import { formatKeys, keyCaps, type ShortcutGroup } from "$lib/shortcuts";

/**
 * The groups of lib/shortcuts.ts cut to the shortcuts whose name, place, group or keys hold every word of the query, so "zoom", "cmd k",
 * "⌘K" and "ctrl shift" each find their rows. A group with no match drops out.
 */
export function filterShortcuts<G extends ShortcutGroup>(groups: readonly G[], query: string): G[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  return groups.flatMap((group) => {
    const shortcuts = group.shortcuts.filter((s) => {
      const keys = [s.keys, ...(s.also ?? [])];
      const text = [
        s.label,
        s.scope ?? "",
        group.label,
        ...keys.flatMap((k) => [formatKeys(k, true), formatKeys(k, false), keyCaps(k, true).join(" "), k.join(" ")]),
        keys.some((k) => k.includes("mod")) ? "cmd command ctrl control" : "",
        keys.some((k) => k.includes("alt")) ? "option opt" : "",
      ].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    });
    return shortcuts.length ? [{ ...group, shortcuts }] : [];
  });
}

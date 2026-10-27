/** FNV-1a 32-bit hash, for stable colors and art from an id or name. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Ten muted hues, used for id chips and default avatars. */
export const MUTED_HUES = [8, 32, 52, 96, 150, 178, 200, 226, 262, 312] as const;

export function hueFor(seed: string): number {
  return MUTED_HUES[hashString(seed) % MUTED_HUES.length]!;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]![0]!.toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * A tag of a read's answer that the page and the server compute alike: FNV-1a and djb2 over its JSON with each object's keys in order, as 16
 * hex digits. A page names the tag of the answer it keeps when it reads over the socket after a reconnect, and the server answers `same`
 * instead of the answer when its own answer has that tag (app.ts `command`). On 11-28 the owner's socket reopened 6 times in 30 minutes, and
 * each reopen read his open board again over it, agent factory's 122 KB with br, while it had not changed (~/work/p155-own-waits/summary.md).
 * The keys go in order because a board the page built from an event's delta orders its keys unlike the server's.
 */
export function answerTag(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, (v as Record<string, unknown>)[key]])) : v);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 0x01000193);
    djb = (Math.imul(djb, 33) + code) | 0;
  }
  return (fnv >>> 0).toString(16).padStart(8, "0") + (djb >>> 0).toString(16).padStart(8, "0");
}

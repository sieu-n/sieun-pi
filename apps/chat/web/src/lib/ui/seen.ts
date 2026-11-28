/**
 * `use:seen={onseen}` calls `onseen(true)` when the element comes onto the screen and `onseen(false)` when it leaves it or unmounts, with one
 * IntersectionObserver for every element. A job pill reads its job ahead only while it shows (stores.svelte.ts `jobShown`).
 */
const watched = new Map<Element, (shown: boolean) => void>();
let observer: IntersectionObserver | undefined;

const observe = (): IntersectionObserver =>
  (observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
  }));

export function seen(element: Element, onseen?: (shown: boolean) => void): { update: (next?: (shown: boolean) => void) => void; destroy: () => void } {
  let current = onseen;
  const start = () => {
    if (!current || typeof IntersectionObserver === "undefined") return;
    watched.set(element, (shown) => current?.(shown));
    observe().observe(element);
  };
  const stop = () => {
    if (!watched.has(element)) return;
    watched.delete(element);
    observer?.unobserve(element);
    current?.(false);
  };
  start();
  return {
    update(next) {
      if (!!next === !!current) {
        current = next;
        return;
      }
      stop();
      current = next;
      start();
    },
    destroy: stop,
  };
}

import { toast } from "$lib/ui/toast.svelte";

const KEY = "chat.interfaceScale";
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.6;

/** Interface size as a CSS zoom on the root, changed in 0.1 steps with Cmd +, Cmd - and Cmd 0 and kept across reloads. */
export const zoom: { scale: number } = $state({ scale: 1 });

let shown: number | undefined;

function apply(scale: number): void {
  zoom.scale = scale;
  document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
  document.documentElement.style.setProperty("--interface-scale", String(scale));
}

/** The current size, for code outside a component; a component reads `zoom.scale`, which updates live. */
export const zoomScale = (): number => zoom.scale;

export function initZoom(): void {
  const saved = Number(localStorage.getItem(KEY));
  if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) apply(saved);
}

/** Sets the size and shows it in a toast with Reset, as a browser shows its zoom level, so a key press never changes it unseen. */
export function setZoom(scale: number, opts: { toast?: boolean } = {}): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(scale * 10) / 10));
  apply(next);
  try {
    if (next === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {}
  if (opts.toast === false) return;
  if (shown !== undefined) toast.dismiss(shown);
  const edge = next === ZOOM_MAX ? " (largest)" : next === ZOOM_MIN ? " (smallest)" : "";
  shown = toast.show(`Interface size ${Math.round(next * 100)}%${edge}`, {
    duration: 2500,
    ...(next === 1 ? {} : { action: { label: "Reset", run: () => setZoom(1) } }),
  });
}

/** One step bigger or smaller, or back to 100% with null. */
export function stepZoom(delta: number | null): void {
  setZoom(delta === null ? 1 : zoom.scale + delta);
}

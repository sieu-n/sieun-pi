const KEY = "chat.interfaceScale";
const MIN = 0.7;
const MAX = 1.6;

function apply(scale: number): void {
  document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
  document.documentElement.style.setProperty("--interface-scale", String(scale));
}

/** Interface size, changed in 0.1 steps with Cmd +, Cmd - and Cmd 0, and kept across reloads. */
export function initZoom(): void {
  const saved = Number(localStorage.getItem(KEY));
  if (saved >= MIN && saved <= MAX) apply(saved);
}

export function stepZoom(delta: number | null): void {
  const current = Number(document.documentElement.style.zoom) || 1;
  const next = delta === null ? 1 : Math.min(MAX, Math.max(MIN, Math.round((current + delta) * 10) / 10));
  apply(next);
  try {
    if (next === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {}
}

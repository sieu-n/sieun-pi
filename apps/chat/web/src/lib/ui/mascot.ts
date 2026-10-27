/** Our own agent mascots: a seeded blob with a face, drawn as SVG. The same seed always draws the same mascot. */

export interface MascotParts {
  body: string;
  shade: string;
  ink: string;
  shape: number;
  eyes: number;
  mouth: number;
  topper: number;
  cheeks: boolean;
}

const BODIES: readonly [string, string][] = [
  ["#ffb35c", "#f07f2a"],
  ["#ffd84d", "#e8a90f"],
  ["#7cc6ff", "#3b8fe0"],
  ["#8be0a4", "#3fae68"],
  ["#c7a6ff", "#8a63e8"],
  ["#ff9ab8", "#e05a86"],
  ["#c8e65a", "#93b622"],
  ["#7fe0d6", "#2fb2a5"],
  ["#ffa48c", "#e8634a"],
  ["#a8b8ff", "#5d72e6"],
];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mascotParts(seed: string): MascotParts {
  let state = hash(seed) || 1;
  const next = (n: number): number => {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489917) >>> 0;
    state = (state ^ (state >>> 16)) >>> 0;
    return state % n;
  };
  const [body, shade] = BODIES[next(BODIES.length)]!;
  return { body, shade, ink: "#1d1d1f", shape: next(4), eyes: next(4), mouth: next(3), topper: next(5), cheeks: next(2) === 0 };
}

const SHAPES = [
  "M64 22c26 0 40 18 40 44s-12 40-40 40-40-14-40-40 14-44 40-44z",
  "M30 34c0-8 6-12 14-12h40c8 0 14 4 14 12v58c0 8-6 12-14 12H44c-8 0-14-4-14-12z",
  "M64 16c10 18 40 34 40 56 0 20-16 34-40 34S24 92 24 72c0-22 30-38 40-56z",
  "M64 24c22 0 44 10 44 40 0 26-18 42-44 42S20 90 20 64c0-30 22-40 44-40z",
];

function eyes(kind: number, ink: string): string {
  if (kind === 0) return `<circle cx="50" cy="60" r="9" fill="#fff"/><circle cx="78" cy="60" r="9" fill="#fff"/><circle cx="52" cy="62" r="4.5" fill="${ink}"/><circle cx="80" cy="62" r="4.5" fill="${ink}"/>`;
  if (kind === 1) return `<circle cx="52" cy="62" r="5" fill="${ink}"/><circle cx="76" cy="62" r="5" fill="${ink}"/><circle cx="53.5" cy="60.5" r="1.6" fill="#fff"/><circle cx="77.5" cy="60.5" r="1.6" fill="#fff"/>`;
  if (kind === 2) return `<path d="M44 62q6-7 12 0M72 62q6-7 12 0" stroke="${ink}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  return `<circle cx="64" cy="58" r="13" fill="#fff"/><circle cx="66" cy="60" r="6" fill="${ink}"/><circle cx="68" cy="58" r="2" fill="#fff"/>`;
}

function mouth(kind: number, ink: string): string {
  if (kind === 0) return `<path d="M56 78q8 8 16 0" stroke="${ink}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  if (kind === 1) return `<ellipse cx="64" cy="80" rx="4.5" ry="5.5" fill="${ink}"/>`;
  return `<path d="M57 79h14" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`;
}

function topper(kind: number, parts: MascotParts): string {
  if (kind === 0) return `<path d="M64 24V10" stroke="${parts.ink}" stroke-width="3" stroke-linecap="round"/><circle cx="64" cy="9" r="5" fill="${parts.shade}"/>`;
  if (kind === 1) return `<path d="M64 24c-2-10 4-16 14-16-2 9-6 14-14 16z" fill="#4caf50"/>`;
  if (kind === 2) return `<path d="M46 30l-6-14 14 8zM82 30l6-14-14 8z" fill="${parts.shade}"/>`;
  if (kind === 3) return `<path d="M54 22q10-12 20 0" stroke="${parts.shade}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  return "";
}

/** The mascot as an SVG string at viewBox 0 0 128 128; `id` keeps gradient ids unique on a page. */
export function mascotSvg(seed: string, id = `m${hash(seed).toString(36)}`): string {
  const parts = mascotParts(seed);
  const cheeks = parts.cheeks ? `<ellipse cx="40" cy="74" rx="6" ry="3.5" fill="#ff6f91" opacity=".45"/><ellipse cx="88" cy="74" rx="6" ry="3.5" fill="#ff6f91" opacity=".45"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" aria-hidden="true">`
    + `<defs><radialGradient id="${id}" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="${parts.body}"/><stop offset="1" stop-color="${parts.shade}"/></radialGradient></defs>`
    + `<ellipse cx="64" cy="116" rx="30" ry="4" fill="#000" opacity=".12"/>`
    + `<rect x="46" y="100" width="12" height="14" rx="6" fill="${parts.shade}"/><rect x="70" y="100" width="12" height="14" rx="6" fill="${parts.shade}"/>`
    + `<ellipse cx="50" cy="114" rx="9" ry="4.5" fill="${parts.ink}"/><ellipse cx="78" cy="114" rx="9" ry="4.5" fill="${parts.ink}"/>`
    + topper(parts.topper, parts)
    + `<path d="${SHAPES[parts.shape]}" fill="url(#${id})"/>`
    + cheeks + eyes(parts.eyes, parts.ink) + mouth(parts.mouth, parts.ink)
    + `</svg>`;
}

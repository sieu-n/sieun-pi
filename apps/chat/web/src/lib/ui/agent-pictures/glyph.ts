import type { DrawStyle } from "../agent-picture";

/**
 * A bold geometric glyph in the swatch ink, like a transit-line badge. Each mark is built from one to three simple shapes inside
 * 6..26 of the 32 by 32 viewBox, with strokes of 3 units or more so it holds at 16 px. `pick` chooses the mark and, for marks
 * with a direction, a quarter turn, so agents that share a color still differ by silhouette.
 */
interface Paint {
  /** Full ink. */
  ink: string;
  /** The second tone: the ink at reduced opacity. */
  soft: string;
  /** The background color, for cutting a shape out of an ink one. */
  bg: string;
}

type Mark = (p: Paint) => string;

const stroke = (color: string, width = 3.5) =>
  `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

/** Marks that look the same at every quarter turn. */
const STILL: Mark[] = [
  // Ring with a centre dot, a target.
  (p) => `<circle cx="16" cy="16" r="8" ${stroke(p.ink)}/><circle cx="16" cy="16" r="3" fill="${p.ink}"/>`,
  // Thick plus.
  (p) => `<path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="${p.ink}"/>`,
  // Diamond with a soft core.
  (p) => `<path d="M16 6l10 10-10 10L6 16z" fill="${p.ink}"/><path d="M16 12l4 4-4 4-4-4z" fill="${p.bg}"/>`,
  // Four dots, one soft.
  (p) => `<g fill="${p.ink}"><circle cx="11" cy="11" r="4"/><circle cx="21" cy="11" r="4"/><circle cx="11" cy="21" r="4"/></g>`
    + `<circle cx="21" cy="21" r="4" fill="${p.soft}"/>`,
  // Four-point sparkle.
  (p) => `<path d="M16 6c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10z" fill="${p.ink}"/>`,
  // Thick X.
  (p) => `<path d="M10 10l12 12M22 10L10 22" ${stroke(p.ink, 4.5)}/>`,
  // Square frame with a solid square inside.
  (p) => `<rect x="8" y="8" width="16" height="16" rx="3" ${stroke(p.ink, 3)}/><rect x="13" y="13" width="6" height="6" rx="1" fill="${p.ink}"/>`,
  // Flower of four quarter discs.
  (p) => `<g fill="${p.ink}"><path d="M15 15H7a8 8 0 0 1 8-8z"/><path d="M17 15V7a8 8 0 0 1 8 8z"/>`
    + `<path d="M17 17h8a8 8 0 0 1-8 8z"/><path d="M15 17v8a8 8 0 0 1-8-8z"/></g>`,
  // Six-spoke asterisk.
  (p) => `<path d="M16 6.5v19M7.8 11.25l16.4 9.5M7.8 20.75l16.4-9.5" ${stroke(p.ink, 3.5)}/>`,
  // Lightning bolt.
  (p) => `<path d="M18.5 5L8 18h7l-2 9 11-13.5h-7z" fill="${p.ink}"/>`,
  // Hexagon nut.
  (p) => `<path d="M16 6l8.7 5v10L16 26l-8.7-5V11z" fill="${p.ink}"/><circle cx="16" cy="16" r="3.5" fill="${p.bg}"/>`,
];

/** Marks with a direction; each is drawn pointing up and turned by a picked quarter turn. */
const TURNED: Mark[] = [
  // Half disc over a bar, a sunrise.
  (p) => `<path d="M7 18a9 9 0 0 1 18 0z" fill="${p.ink}"/><rect x="7" y="21" width="18" height="3.5" rx="1.75" fill="${p.ink}"/>`,
  // Triangle, a peak.
  (p) => `<path d="M16 6.5l10 17.5H6z" fill="${p.ink}" stroke="${p.ink}" stroke-width="1.5" stroke-linejoin="round"/>`,
  // Two stacked chevrons, the back one soft.
  (p) => `<path d="M8 23l8-8 8 8" ${stroke(p.ink, 4)}/><path d="M8 15l8-8 8 8" ${stroke(p.soft, 4)}/>`,
  // Three rising bars.
  (p) => `<g fill="${p.ink}"><rect x="7" y="18" width="4.5" height="8" rx="1"/><rect x="13.75" y="12" width="4.5" height="14" rx="1"/>`
    + `<rect x="20.5" y="6" width="4.5" height="20" rx="1"/></g>`,
  // Crescent.
  (p) => `<circle cx="16" cy="16" r="10" fill="${p.ink}"/><circle cx="20" cy="11" r="8" fill="${p.bg}"/>`,
  // Two offset circles, one soft.
  (p) => `<circle cx="16" cy="11.5" r="6" fill="${p.soft}"/><circle cx="16" cy="20.5" r="6" fill="${p.ink}"/>`,
  // Two quarter arcs and a dot, a signal.
  (p) => `<circle cx="10" cy="22" r="3.2" fill="${p.ink}"/><path d="M10 13.5a8.5 8.5 0 0 1 8.5 8.5" ${stroke(p.ink, 3.8)}/>`
    + `<path d="M10 7a15 15 0 0 1 15 15" ${stroke(p.ink, 3.8)}/>`,
  // Arrow up.
  (p) => `<path d="M16 7v18M8.5 14.5L16 7l7.5 7.5" ${stroke(p.ink, 4.5)}/>`,
  // Bookmark flag with a notch.
  (p) => `<path d="M9 6h14v20l-7-5.5L9 26z" fill="${p.ink}" stroke="${p.ink}" stroke-width="1" stroke-linejoin="round"/>`,
  // Split disc, one half soft.
  (p) => `<path d="M16 6a10 10 0 0 0 0 20z" fill="${p.ink}"/><path d="M16 6a10 10 0 0 1 0 20z" fill="${p.soft}"/>`,
  // Teardrop with one sharp corner.
  (p) => `<path d="M16 6h10v10a10 10 0 1 1-10-10z" fill="${p.ink}"/>`,
  // Leaf with two sharp corners and a soft vein.
  (p) => `<path d="M6 26V16A10 10 0 0 1 16 6h10v10a10 10 0 0 1-10 10z" fill="${p.ink}"/><path d="M11 21l10-10" ${stroke(p.bg, 2.5)}/>`,
  // Stairs.
  (p) => `<path d="M6 26v-6.5h6.5V13H19V6.5h7V26z" fill="${p.ink}"/>`,
  // Hourglass.
  (p) => `<path d="M8 6.5h16L8 25.5h16z" fill="${p.ink}" stroke="${p.ink}" stroke-width="1.5" stroke-linejoin="round"/>`,
  // Open ring with a dot in the gap.
  (p) => `<path d="M22.4 9.6A9 9 0 1 1 9.6 9.6" ${stroke(p.ink)}/><circle cx="16" cy="7" r="2.6" fill="${p.ink}"/>`,
  // Magnet, a thick U.
  (p) => `<path d="M9.5 7.5V16a6.5 6.5 0 0 0 13 0V7.5" ${stroke(p.ink, 5)}/>`,
  // Pause bars with a soft third.
  (p) => `<g fill="${p.ink}"><rect x="7" y="7" width="5" height="18" rx="2"/><rect x="13.5" y="7" width="5" height="18" rx="2"/></g>`
    + `<rect x="20" y="7" width="5" height="18" rx="2" fill="${p.soft}"/>`,
  // Disc with a quarter cut out and a soft dot in the gap.
  (p) => `<path d="M16 16V6a10 10 0 1 0 10 10z" fill="${p.ink}"/><circle cx="21" cy="11" r="3" fill="${p.soft}"/>`,
];

/** The ink as rgba at 45% opacity; the swatch ink is a #rrggbb hex. */
function softInk(ink: string): string {
  const value = Number.parseInt(ink.slice(1, 7), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},0.45)`;
}

export const glyph: DrawStyle = ({ swatch, pick }) => {
  const paint: Paint = {
    ink: swatch.ink,
    soft: softInk(swatch.ink),
    bg: swatch.bg,
  };
  const index = pick(STILL.length + TURNED.length);
  if (index < STILL.length) return STILL[index]!(paint);
  const turn = pick(4) * 90;
  const mark = TURNED[index - STILL.length]!(paint);
  return turn ? `<g transform="rotate(${turn} 16 16)">${mark}</g>` : mark;
};

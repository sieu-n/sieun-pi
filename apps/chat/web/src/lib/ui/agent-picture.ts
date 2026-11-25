/**
 * Agent pictures: a flat, high-contrast mark on a strong color, drawn as SVG from the agent's id and name. The same seed and name always
 * draw the same picture. The owner picks one of three styles in Preferences (picture-style.svelte.ts); Avatar, AgentPicture, the agent
 * card and the create dialog all draw through `pictureSvg` or `pictureNode`.
 */
import { hashString } from "./hash.ts";
import { glyph } from "./agent-pictures/glyph.ts";
import { monogram } from "./agent-pictures/monogram.ts";
import { symbol } from "./agent-pictures/symbol.ts";

export type PictureStyle = "glyph" | "monogram" | "symbol";

export const PICTURE_STYLES: { value: PictureStyle; label: string }[] = [
  { value: "symbol", label: "Symbol" },
  { value: "glyph", label: "Shape" },
  { value: "monogram", label: "Letters" },
];

/** The style a browser shows until the owner picks another in Preferences. */
export const DEFAULT_PICTURE_STYLE: PictureStyle = "symbol";

export function isPictureStyle(value: unknown): value is PictureStyle {
  return PICTURE_STYLES.some((style) => style.value === value);
}

/** A background color and the ink drawn on it; each ink has at least 4.5:1 contrast on its background. */
export interface Swatch {
  bg: string;
  ink: string;
}

export const SWATCHES: readonly Swatch[] = [
  { bg: "#d62839", ink: "#ffffff" },
  { bg: "#e8590c", ink: "#1d1d1f" },
  { bg: "#f59f00", ink: "#1d1d1f" },
  { bg: "#74b816", ink: "#1d1d1f" },
  { bg: "#2f7d32", ink: "#ffffff" },
  { bg: "#0b7285", ink: "#ffffff" },
  { bg: "#1971c2", ink: "#ffffff" },
  { bg: "#3b5bdb", ink: "#ffffff" },
  { bg: "#7048e8", ink: "#ffffff" },
  { bg: "#ae3ec9", ink: "#ffffff" },
  { bg: "#d6336c", ink: "#ffffff" },
  { bg: "#12b886", ink: "#1d1d1f" },
  { bg: "#8c5a2b", ink: "#ffffff" },
  { bg: "#15aabf", ink: "#1d1d1f" },
];

/** What a style draws from: the seed, the display name, its color and a seeded number source. */
export interface PictureInput {
  seed: string;
  name: string;
  swatch: Swatch;
  /** The next seeded integer in [0, n); the same seed gives the same sequence. */
  pick: (n: number) => number;
}

/** A style returns the marks inside a 32 by 32 viewBox; `pictureSvg` draws the rounded background under them. */
export type DrawStyle = (input: PictureInput) => string;

const STYLES: Record<PictureStyle, DrawStyle> = { glyph, monogram, symbol };

export function pictureSwatch(seed: string): Swatch {
  return SWATCHES[hashString(seed) % SWATCHES.length]!;
}

function input(seed: string, name: string): PictureInput {
  let state = hashString(`${seed}#mark`) || 1;
  const pick = (n: number): number => {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489917) >>> 0;
    state = (state ^ (state >>> 16)) >>> 0;
    return state % n;
  };
  return { seed, name, swatch: pictureSwatch(seed), pick };
}

/** The picture as an SVG string at viewBox 0 0 32 32, with a rounded square background that matches Avatar's agent squircle. */
export function pictureSvg(style: PictureStyle, seed: string, name: string = seed): string {
  const data = input(seed, name);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" data-picture="${style}">`
    + `<rect width="32" height="32" rx="10" fill="${data.swatch.bg}"/>`
    + STYLES[style](data)
    + `</svg>`;
}

const parsed = new Map<string, SVGSVGElement>();

/** The picture as an SVG element. Each picture's markup is parsed once and cloned after, since a thread open draws dozens of avatars. */
export function pictureNode(style: PictureStyle, seed: string, name: string = seed): SVGSVGElement {
  const key = `${style}\u0000${seed}\u0000${name}`;
  let svg = parsed.get(key);
  if (!svg) {
    const template = document.createElement("template");
    template.innerHTML = pictureSvg(style, seed, name);
    svg = template.content.firstElementChild as SVGSVGElement;
    parsed.set(key, svg);
  }
  return svg.cloneNode(true) as SVGSVGElement;
}

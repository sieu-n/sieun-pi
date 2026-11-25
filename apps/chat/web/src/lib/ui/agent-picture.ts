/**
 * Agent pictures: a flat, high-contrast mark on a strong color, drawn as SVG from the agent's id and name. The same seed and name always
 * draw the same picture. The owner picks one of three styles in Preferences (picture-style.svelte.ts); Avatar, AgentPicture, the agent
 * card and the create dialog all draw through `pictureSvg` or `pictureNode`. `assignPictures` gives every registered agent its own color
 * and symbol; a job or thread with no assignment takes both from its seed.
 */
import { hashString } from "./hash.ts";
import { glyph } from "./agent-pictures/glyph.ts";
import { monogram } from "./agent-pictures/monogram.ts";
import { symbol, symbolChoices, type SymbolName } from "./agent-pictures/symbol.ts";

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
  { bg: "#339af0", ink: "#1d1d1f" },
  { bg: "#1d3a8a", ink: "#ffffff" },
  { bg: "#ff8787", ink: "#1d1d1f" },
  { bg: "#5f6b7a", ink: "#ffffff" },
  { bg: "#a61e4d", ink: "#ffffff" },
  { bg: "#5c7f0d", ink: "#ffffff" },
  { bg: "#e599f7", ink: "#1d1d1f" },
  { bg: "#ffd43b", ink: "#1d1d1f" },
];

/** The color and symbol `assignPictures` gave one registered agent. */
export interface Assignment {
  swatch: Swatch;
  symbol: SymbolName;
}

/** What a style draws from: the seed, the display name, its color, its assignment if it has one and a seeded number source. */
export interface PictureInput {
  seed: string;
  name: string;
  swatch: Swatch;
  seedHash: number;
  assigned: Assignment | undefined;
  /** The next seeded integer in [0, n); the same seed gives the same sequence. */
  pick: (n: number) => number;
}

/** A style returns the marks inside a 32 by 32 viewBox; `pictureSvg` draws the rounded background under them. */
export type DrawStyle = (input: PictureInput) => string;

const STYLES: Record<PictureStyle, DrawStyle> = { glyph, monogram, symbol };

export function pictureSwatch(seed: string): Swatch {
  return SWATCHES[hashString(seed) % SWATCHES.length]!;
}

export interface PictureAgent {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * Each agent's color and symbol, different from every other agent's while the list has no more agents than SWATCHES has colors. Agents
 * take them oldest first, each the first free color from where its id's hash points and the first free symbol of `symbolChoices`, so a
 * new agent never changes an older agent's picture.
 */
export function assignPictures(list: readonly PictureAgent[]): Map<string, Assignment> {
  const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const colors = new Set<number>();
  const symbols = new Set<SymbolName>();
  const assigned = new Map<string, Assignment>();
  for (const agent of ordered) {
    const hash = hashString(agent.id);
    const start = hash % SWATCHES.length;
    const step = SWATCHES.findIndex((_, i) => !colors.has((start + i) % SWATCHES.length));
    const color = (start + Math.max(step, 0)) % SWATCHES.length;
    const choices = symbolChoices(agent.name, hash);
    const mark = choices.find((choice) => !symbols.has(choice)) ?? choices[0]!;
    colors.add(color);
    symbols.add(mark);
    assigned.set(agent.id, { swatch: SWATCHES[color]!, symbol: mark });
  }
  return assigned;
}

function input(seed: string, name: string, assigned: Assignment | undefined): PictureInput {
  let state = hashString(`${seed}#mark`) || 1;
  const pick = (n: number): number => {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489917) >>> 0;
    state = (state ^ (state >>> 16)) >>> 0;
    return state % n;
  };
  return { seed, name, swatch: assigned?.swatch ?? pictureSwatch(seed), seedHash: hashString(seed), assigned, pick };
}

/** The picture as an SVG string at viewBox 0 0 32 32, with a rounded square background that matches Avatar's agent squircle. */
export function pictureSvg(style: PictureStyle, seed: string, name: string = seed, assigned?: Assignment): string {
  const data = input(seed, name, assigned);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" data-picture="${style}">`
    + `<rect width="32" height="32" rx="10" fill="${data.swatch.bg}"/>`
    + STYLES[style](data)
    + `</svg>`;
}

const parsed = new Map<string, SVGSVGElement>();

/** The picture as an SVG element. Each picture's markup is parsed once and cloned after, since a thread open draws dozens of avatars. */
export function pictureNode(style: PictureStyle, seed: string, name: string = seed, assigned?: Assignment): SVGSVGElement {
  const key = `${style}\u0000${seed}\u0000${name}\u0000${assigned ? `${assigned.swatch.bg}${assigned.symbol}` : ""}`;
  let svg = parsed.get(key);
  if (!svg) {
    const template = document.createElement("template");
    template.innerHTML = pictureSvg(style, seed, name, assigned);
    svg = template.content.firstElementChild as SVGSVGElement;
    parsed.set(key, svg);
  }
  return svg.cloneNode(true) as SVGSVGElement;
}

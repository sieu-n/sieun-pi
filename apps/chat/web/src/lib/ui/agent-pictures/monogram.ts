import type { DrawStyle } from "../agent-picture.ts";

/** Words that name the kind of agent rather than the agent, so they never give a letter. */
const FILLER = new Set(["guy", "bot", "the", "and", "a", "an", "of", "for", "to", "my", "misc"]);

/** Rough advance widths of Inter's heavy capitals and digits, in em, so two wide letters shrink to fit the tile. */
const WIDTH: Record<string, number> = {
  I: 0.3, J: 0.55, L: 0.58, F: 0.6, E: 0.62, T: 0.64, S: 0.66, P: 0.68, Z: 0.66, B: 0.7, K: 0.72, R: 0.7,
  C: 0.74, D: 0.76, G: 0.78, H: 0.78, N: 0.78, U: 0.76, V: 0.76, X: 0.74, Y: 0.74, A: 0.76, O: 0.8, Q: 0.8,
  M: 0.92, W: 1.06,
};
const width = (ch: string): number => WIDTH[ch] ?? (ch.charCodeAt(0) > 0x2fff ? 1 : 0.66);

/**
 * One or two letters from the name: the first letter of each of the first two words, after dropping anything in brackets and filler
 * words such as "guy". "devops guy" gives D, "knowledge manager (...)" gives KM, "API portal" gives AP.
 */
export function monogramLetters(name: string): string {
  const split = (text: string): string[] => text.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const outside = split(name.replace(/\([^)]*\)?|\[[^\]]*\]?/g, " "));
  const words = outside.length > 0 ? outside : split(name);
  const kept = words.filter((word) => !FILLER.has(word.toLowerCase()));
  const use = kept.length > 0 ? kept : words;
  if (use.length === 0) return "?";
  const letters = use.slice(0, 2).map((word) => Array.from(word)[0]!.toLocaleUpperCase());
  return letters.join("");
}

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ESCAPE[ch]!);

/**
 * The name's one or two letters in heavy swatch ink, sized so the pair spans at most 23 of the 32 units. A stroke in the same ink thickens
 * the letters, so they stay heavy at 16 px even where the page font has no 800 weight.
 */
export const monogram: DrawStyle = ({ name, swatch }) => {
  const letters = monogramLetters(name);
  const chars = Array.from(letters);
  const pair = chars.length > 1;
  const em = chars.reduce((sum, ch) => sum + width(ch), 0);
  const size = Math.min(pair ? 17.5 : 22, 23 / em);
  const stroke = size * 0.045;
  return `<text x="16" y="16.2" text-anchor="middle" dominant-baseline="central" font-family="inherit" font-weight="800"`
    + ` font-size="${size.toFixed(1)}"${pair ? ` letter-spacing="${(stroke * 0.6).toFixed(2)}"` : ""}`
    + ` fill="${swatch.ink}" stroke="${swatch.ink}" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round">`
    + `${escapeXml(letters)}</text>`;
};

import type { DrawStyle, Swatch } from "../agent-picture.ts";

/** One role symbol: the marks inside the 32 by 32 viewBox, drawn in `ink` with `bg` for cut-outs. */
type Draw = (c: Swatch) => string;

const line = (ink: string, d: string, width = 2.5) =>
  `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

const SYMBOLS = {
  spider: ({ ink }) =>
    line(ink, "M13 15 L8 11 L7 7 M13 17.5 L7 17 L5.5 14 M13 20 L8 23 L7.5 26 M19 15 L24 11 L25 7 M19 17.5 L25 17 L26.5 14 M19 20 L24 23 L24.5 26", 2.5)
    + `<circle cx="16" cy="11.5" r="3" fill="${ink}"/><ellipse cx="16" cy="18.5" rx="4.5" ry="5.5" fill="${ink}"/>`,
  wrench: ({ ink, bg }) =>
    line(ink, "M9 23 L17.5 14.5", 4.5)
    + `<circle cx="20" cy="12" r="6" fill="${ink}"/>`
    + `<path d="M20.5 11.5 L25 7 L29 11 L24.5 15.5 Z" fill="${bg}"/>`,
  factory: ({ ink }) => `<path d="M6 25 V14 L11.5 17.5 V14 L17 17.5 V14 L22 17.5 V7 H26 V25 Z" fill="${ink}"/>`,
  magnifier: ({ ink }) =>
    `<circle cx="14" cy="14" r="6" fill="none" stroke="${ink}" stroke-width="3.2"/>` + line(ink, "M18.8 18.8 L24.5 24.5", 4),
  trend: ({ ink }) =>
    line(ink, "M6.5 22.5 L12.5 16 L16.5 19.5 L23 12.5", 3.2)
    + `<path d="M17.5 9.5 H25.5 V17.5 Z" fill="${ink}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>`,
  eye: ({ ink, bg }) =>
    `<path d="M4.5 16 Q16 4.5 27.5 16 Q16 27.5 4.5 16 Z" fill="${ink}"/>`
    + `<circle cx="16" cy="16" r="4.6" fill="${bg}"/><circle cx="16" cy="16" r="2.3" fill="${ink}"/>`,
  bars: ({ ink }) =>
    `<rect x="7" y="17" width="5" height="8" rx="1" fill="${ink}"/>`
    + `<rect x="13.5" y="12" width="5" height="13" rx="1" fill="${ink}"/>`
    + `<rect x="20" y="7" width="5" height="18" rx="1" fill="${ink}"/>`,
  book: ({ ink }) =>
    `<path d="M15.2 10 Q11 7.5 6 8.5 V23.5 Q11 22.5 15.2 25 Z" fill="${ink}"/>`
    + `<path d="M16.8 10 Q21 7.5 26 8.5 V23.5 Q21 22.5 16.8 25 Z" fill="${ink}"/>`,
  braces: ({ ink }) =>
    line(ink, "M12.5 7.5 H11.5 Q9.5 7.5 9.5 9.5 V13.5 L7 16 L9.5 18.5 V22.5 Q9.5 24.5 11.5 24.5 H12.5", 2.8)
    + line(ink, "M19.5 7.5 H20.5 Q22.5 7.5 22.5 9.5 V13.5 L25 16 L22.5 18.5 V22.5 Q22.5 24.5 20.5 24.5 H19.5", 2.8)
    + `<circle cx="16" cy="16" r="1.9" fill="${ink}"/>`,
  plug: ({ ink }) =>
    `<rect x="12" y="5.5" width="2.8" height="6" rx="1" fill="${ink}"/><rect x="17.2" y="5.5" width="2.8" height="6" rx="1" fill="${ink}"/>`
    + `<path d="M9 11 H23 V15 Q23 21 16 21 Q9 21 9 15 Z" fill="${ink}"/>`
    + line(ink, "M16 20 V26", 3.2),
  puzzle: ({ ink }) =>
    `<path d="M8 11 H12.5 A3 3 0 1 1 17.5 11 H22 V15.5 A3 3 0 1 1 22 20.5 V25 H8 Z" fill="${ink}"/>`,
  person: ({ ink }) =>
    `<circle cx="16" cy="11.5" r="4.8" fill="${ink}"/><path d="M7 25.5 Q7 18 16 18 Q25 18 25 25.5 Z" fill="${ink}"/>`,
  bubble: ({ ink, bg }) =>
    `<path d="M10 7.5 H22 Q26 7.5 26 11.5 V17.5 Q26 21.5 22 21.5 H15 L9 26 V21.5 Q6 21 6 17.5 V11.5 Q6 7.5 10 7.5 Z" fill="${ink}"/>`
    + `<circle cx="11.5" cy="14.5" r="1.7" fill="${bg}"/><circle cx="16" cy="14.5" r="1.7" fill="${bg}"/><circle cx="20.5" cy="14.5" r="1.7" fill="${bg}"/>`,
  sparkle: ({ ink }) =>
    `<path d="M14 6 Q15 15 23 16.5 Q15 18 14 27 Q13 18 5 16.5 Q13 15 14 6 Z" fill="${ink}"/>`
    + `<path d="M22.5 5 Q23 8.5 26.5 9 Q23 9.5 22.5 13 Q22 9.5 18.5 9 Q22 8.5 22.5 5 Z" fill="${ink}"/>`,
  flask: ({ ink }) =>
    line(ink, "M12.5 6.5 H19.5 M14 6.5 V13 L8 23.5 Q7.2 25.5 9.5 25.5 H22.5 Q24.8 25.5 24 23.5 L18 13 V6.5", 2.6)
    + `<path d="M11 18.5 H21 L24 23.5 Q24.8 25.5 22.5 25.5 H9.5 Q7.2 25.5 8 23.5 Z" fill="${ink}"/>`,
  nib: ({ ink, bg }) =>
    `<path d="M16 27 L8.5 16.5 L11.5 6 H20.5 L23.5 16.5 Z" fill="${ink}"/>`
    + `<circle cx="16" cy="15" r="2.2" fill="${bg}"/>` + line(bg, "M16 17 V25.5", 1.6),
  box: ({ ink, bg }) =>
    `<path d="M16 5 L26 10.5 V21.5 L16 27 L6 21.5 V10.5 Z" fill="${ink}"/>`
    + line(bg, "M6.5 10.8 L16 16 L25.5 10.8 M16 16 V26.5", 1.8),
  bolt: ({ ink }) => `<path d="M18.5 5 L8.5 18 H15 L13 27 L23.5 13.5 H17 Z" fill="${ink}"/>`,
  megaphone: ({ ink }) =>
    `<path d="M6 13 H11 L23 6.5 V25.5 L11 19 H6 Z" fill="${ink}"/>`
    + `<path d="M10 19 H15 L16.5 26 H12.5 Z" fill="${ink}"/>` + line(ink, "M26.5 13 V19", 2.6),
  database: ({ ink, bg }) =>
    `<path d="M7 9.5 Q7 5.5 16 5.5 Q25 5.5 25 9.5 V22.5 Q25 26.5 16 26.5 Q7 26.5 7 22.5 Z" fill="${ink}"/>`
    + line(bg, "M7.5 11 Q16 15.5 24.5 11 M7.5 16.5 Q16 21 24.5 16.5", 1.8),
  target: ({ ink, bg }) =>
    `<circle cx="16" cy="16" r="10.5" fill="${ink}"/><circle cx="16" cy="16" r="7" fill="${bg}"/><circle cx="16" cy="16" r="3.6" fill="${ink}"/>`,
  globe: ({ ink, bg }) =>
    `<circle cx="16" cy="16" r="10.5" fill="${ink}"/>`
    + `<ellipse cx="16" cy="16" rx="4.4" ry="10" fill="none" stroke="${bg}" stroke-width="1.8"/>` + line(bg, "M6 16 H26", 1.8),
  key: ({ ink, bg }) =>
    `<circle cx="11" cy="16" r="6" fill="${ink}"/><circle cx="9.8" cy="16" r="2.2" fill="${bg}"/>`
    + line(ink, "M15 16 H26.5", 3.4) + line(ink, "M22 16 V21 M26 16 V20", 3),
  gear: ({ ink, bg }) =>
    [0, 45, 90, 135].map((turn) => `<rect x="13.6" y="5" width="4.8" height="22" rx="1.2" fill="${ink}" transform="rotate(${turn} 16 16)"/>`).join("")
    + `<circle cx="16" cy="16" r="7.8" fill="${ink}"/><circle cx="16" cy="16" r="3.2" fill="${bg}"/>`,
  compass: ({ ink, bg }) =>
    `<circle cx="16" cy="16" r="10.5" fill="${ink}"/>`
    + `<path d="M21.5 10.5 L17.8 17.8 L10.5 21.5 L14.2 14.2 Z" fill="${bg}"/><circle cx="16" cy="16" r="1.6" fill="${ink}"/>`,
  rocket: ({ ink, bg }) =>
    `<path d="M16 5 Q22 9.5 21 19 H11 Q10 9.5 16 5 Z" fill="${ink}"/>`
    + `<path d="M11 14 L7 20 V23 L11.5 20.5 Z M21 14 L25 20 V23 L20.5 20.5 Z" fill="${ink}"/>`
    + `<circle cx="16" cy="12.5" r="2.2" fill="${bg}"/>` + line(ink, "M16 21.5 V26.5", 3),
} satisfies Record<string, Draw>;

export type SymbolName = keyof typeof SYMBOLS;

/** Role keywords in priority order; the first that appears as a whole word in the name wins, so "product analytics bot" draws bars. */
const ROLES: readonly [RegExp, SymbolName][] = [
  [/\b(analytics?|metrics?|stats?|dashboards?)\b/i, "bars"],
  [/\b(chrome|extensions?|plugins?)\b/i, "puzzle"],
  [/\b(knowledge|wiki|docs?|llm-wiki)\b/i, "book"],
  [/\b(auditors?|audit|review(er)?|watch(er)?)\b/i, "eye"],
  [/\b(crawlers?|crawl|scrap(er|ing)|spider)\b/i, "spider"],
  [/\b(devops|ops|infra|deploy)\b/i, "wrench"],
  [/\bseo\b/i, "trend"],
  [/\b(search|find|lookup)\b/i, "magnifier"],
  [/\bfactory\b/i, "factory"],
  [/\bapi\b/i, "braces"],
  [/\bmcp\b/i, "plug"],
  [/\b(contacts?|people|person|leads?)\b/i, "person"],
  [/\b(vent|chat|talk|feedback)\b/i, "bubble"],
  [/\b(gpt|ai|llm|openai)\b/i, "sparkle"],
  [/\b(probe|experiments?|lab|tests?)\b/i, "flask"],
  [/\b(designer|design|ui|icons?|iconic|avatars?)\b/i, "nib"],
  [/\b(products?|package|shop)\b/i, "box"],
  [/\b(gtm|sales|marketing|outreach|ads?)\b/i, "megaphone"],
  [/\b(crm|data|database|db|sql)\b/i, "database"],
  [/\b(goals?|strategy|plans?|okrs?)\b/i, "target"],
  [/\b(web|global|i18n|sites?)\b/i, "globe"],
  [/\b(auth|security|secrets?|keys?)\b/i, "key"],
  [/\b(build|config|settings|harness|automation)\b/i, "gear"],
  [/\b(explore|research|guide|scout)\b/i, "compass"],
  [/\b(launch|growth|ship)\b/i, "rocket"],
  [/\b(fast|speed|perf|quick)\b/i, "bolt"],
];

const NAMES = Object.keys(SYMBOLS) as SymbolName[];

/**
 * Every symbol in the order an agent would take it: the role words its name matches, in ROLES order, then the rest of the set from a
 * point the seed picks. assignPictures gives each agent the first one no older agent holds.
 */
export function symbolChoices(name: string, seed: number): SymbolName[] {
  const roles = ROLES.filter(([pattern]) => pattern.test(name)).map(([, role]) => role);
  const start = seed % NAMES.length;
  const rest = NAMES.map((_, i) => NAMES[(start + i) % NAMES.length]!);
  return [...new Set([...roles, ...rest])];
}

/** A bold flat symbol for the agent's role, read from its name, or the one assignPictures gave it so no two agents share one. */
export const symbol: DrawStyle = ({ name, swatch, seedHash, assigned }) => SYMBOLS[assigned?.symbol ?? symbolChoices(name, seedHash)[0]!](swatch);

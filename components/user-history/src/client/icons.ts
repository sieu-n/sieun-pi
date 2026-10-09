import type { ArtifactTarget } from "../shared/artifact-link.ts";

/** Every icon the page draws: a 24-box stroke path (1.8 wide, round caps). `Icon.svelte` draws one; `inlineIcon` writes one into rendered markdown. */
export const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4",
  sidebar: "M4 5h16v14H4zM9 5v14",
  pencil: "M4 20h4l10-10-4-4L4 16zM13 7l4 4",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5L20 7",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  tag: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  send: "M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z",
  stop: "M7 7h10v10H7z",
  image: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01",
  copy: "M9 9h11v11H9zM5 15V4h11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  users: "M16 19v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM21 19v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8",
  arrowDown: "M12 5v14M5 12l7 7 7-7",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  folder: "M3 6h6l2 2h10v11H3z",
  note: "M4 4h16v11l-5 5H4zM15 20v-5h5M8 9h8M8 13h5",
  plan: "M3 7l2 2 4-4M3 13l2 2 4-4M3 19h6M13 6h8M13 12h8M13 18h8",
  menu: "M4 7h16M4 12h16M4 17h16",
  steer: "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
  sparkle: "M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  account: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 20a8 8 0 0 1 16 0",
  settings: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
  briefcase: "M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  table: "M3 5h18v14H3zM3 10h18M3 15h18M9 10v9",
  columns: "M3 5h18v14H3zM12 5v14",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5",
  reply: "M9 17l-5-5 5-5M4 12h12a4 4 0 0 1 4 4v2",
  message: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z",
  page: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  file: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5",
  globe: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  expand: "M7 15l5 5 5-5M7 9l5-5 5 5",
  collapse: "M7 20l5-5 5 5M7 4l5 5 5-5",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  expandBox: "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7",
  external: "M14 4h6v6M20 4l-9 9M11 6H5v13h13v-6",
  slack: "M9.5 3.5v7M14.5 13.5v7M3.5 14.5h7M13.5 9.5h7M14.5 4.5v1M9.5 18.5v1M4.5 9.5h1M18.5 14.5h1",
} as const;
export type IconName = keyof typeof ICON_PATHS;

/** The icon in front of a link to an artifact, by what it opens; `broken` is a note link whose target cannot be opened. */
export const ARTIFACT_ICON: Record<ArtifactTarget["kind"] | "broken", IconName> = { job: "briefcase", thread: "message", wiki: "page", file: "file", url: "globe", broken: "link" };
/** The icon of a stored target (`job:x`, `thread:x`, `wiki:x`, `file:x`; anything else is a web URL). */
export function targetIcon(target: string): IconName {
  const kind = /^(job|thread|wiki|file):/.exec(target)?.[1] as "job" | "thread" | "wiki" | "file" | undefined;
  return ARTIFACT_ICON[kind ?? "url"];
}

/** The same glyph as `Icon.svelte`, as a string for rendered markdown; sized by the `.link-icon` rule in app.css. */
export function inlineIcon(name: IconName): string {
  return `<svg class="link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}

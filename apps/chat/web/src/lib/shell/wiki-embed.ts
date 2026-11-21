/**
 * The look of a wiki page shown in the artifact viewer's frame. The wiki (apps/wiki) has one light theme and its own top bar, page tree
 * and page header, so the viewer hides those and maps the wiki's colour variables to this app's tokens, read from this document, so the
 * page follows the app's light or dark mode. The popup's own header carries the title and the actions.
 */

/** The wiki's colour variables (apps/wiki/src/app.css) and the app token each one takes. */
const PALETTE: Record<string, string> = {
  "--bg": "--surface-popover",
  "--surface": "--surface-popover",
  "--surface-alt": "--surface-inset",
  "--ink": "--text-standard",
  "--ink-soft": "--text-subtle",
  "--ink-muted": "--text-metadata",
  "--accent": "--text-message-link",
  "--accent-soft": "--surface-sidebar-selected",
  "--border": "--border-standard",
  "--border-soft": "--border-standard",
};

/** The frame hides the wiki's own chrome and the page header that repeats the popup's title. */
const LAYOUT = `
.topbar, .browse-btn, .rail-tab, .tree-rail, .page-head { display: none !important; }
.body { grid-template-columns: minmax(0, 1fr) !important; }
.page { padding-top: 24px !important; }
.rail { top: 16px !important; }
/* While the pane edits the page in place (wiki-page.ts), the side rail folds away and the page takes the width. */
[data-chat-editing] .rail, [data-chat-editing] .toc-dock { display: none !important; }
[data-chat-editing] .page-grid { grid-template-columns: minmax(0, 1fr) !important; }
[data-chat-editing] .prose { min-height: 60vh; outline: none; caret-color: var(--accent); }
[data-chat-editing] .prose pre.mermaid { white-space: pre-wrap; }
`;

/**
 * The wiki's fixed light colours that the variables do not reach, redone from the mapped variables. Tinted panels and status chips keep
 * their hue through color-mix, so they read in both modes.
 */
const FIXED = `
.prose { color: var(--ink) !important; }
.prose a { text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent) !important; }
.prose blockquote { border-left-color: var(--border) !important; }
.prose .wiki-panel.note, .prose .wiki-status.redirect { background: color-mix(in srgb, #5b7fa6 14%, var(--surface)) !important; }
.prose .wiki-panel.warning, .prose .wiki-status.degraded { background: color-mix(in srgb, #c79321 14%, var(--surface)) !important; }
.prose .wiki-panel.danger, .prose .wiki-status.json-error { background: color-mix(in srgb, #c0492f 14%, var(--surface)) !important; }
.prose .wiki-status.html-shell { background: color-mix(in srgb, #61458e 14%, var(--surface)) !important; }
.prose .wiki-status.invalid { background: color-mix(in srgb, #8a4d24 14%, var(--surface)) !important; }
.pill.warn { background: color-mix(in srgb, #c79321 14%, var(--surface)) !important; color: var(--ink-soft) !important; }
`;

/** Lighter text on the dark tints, where the wiki's dark label colours would not read. */
const DARK = `
.prose .wiki-panel .wiki-panel-label, .prose .wiki-status { color: var(--ink-soft) !important; }
.toc-dock-btn, .toc-dock-panel { box-shadow: 0 0 0 1px var(--border) !important; }
`;

/**
 * The stylesheet for a frame, from the variables of `root`, the app's html element. The frame element undoes the app's interface size
 * (ArtifactViewer.svelte) and the page's root takes it again here, because WebKit, the Mac app's engine, draws a frame at the app's zoom
 * but lays its page out at the unzoomed width, which cut off the page's right side.
 */
export function wikiEmbedCss(root: HTMLElement): string {
  const style = getComputedStyle(root);
  const dark = root.dataset.colorMode === "dark";
  const scale = Number(root.style.zoom) || 1;
  const vars = Object.entries(PALETTE)
    .map(([wiki, app]) => `${wiki}: ${style.getPropertyValue(app).trim()} !important;`)
    .join(" ");
  return `:root { ${vars} color-scheme: ${dark ? "dark" : "light"} !important; zoom: ${scale} !important; }\nhtml, body { background: var(--bg) !important; }\n${LAYOUT}${FIXED}${dark ? DARK : ""}`;
}

/**
 * Puts the stylesheet in the frame's document and rewrites it when the app's colour mode or interface size changes. Returns the stop
 * function for the observer.
 */
export function styleWikiFrame(doc: Document): () => void {
  let style = doc.querySelector<HTMLStyleElement>("style[data-chat-embed]");
  if (!style) {
    style = doc.createElement("style");
    style.dataset.chatEmbed = "";
    doc.head.append(style);
  }
  const sheet = style;
  const apply = () => {
    sheet.textContent = wikiEmbedCss(document.documentElement);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode", "style"] });
  return () => observer.disconnect();
}

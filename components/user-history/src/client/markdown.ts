import { Marked, type Token } from "marked";
import { normalizeArtifactTarget } from "../shared/artifact-link.ts";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Fenced block languages drawn in the sandboxed `render` frame. */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);
/** The thread folder, for image paths relative to it. Set around each synchronous parse. */
let renderCwd = "";

/**
 * Where a markdown image loads from: https and data URLs as they are, and a file on this Mac (absolute, `~/`, `file://`, or
 * relative to the thread folder) through `api/local-image`. Anything else stays as text.
 */
export function imageSource(href: string, cwd: string): string | null {
  if (/^https:\/\//i.test(href)) return href;
  if (/^data:image\/(png|jpeg|gif|webp);/i.test(href)) return href;
  let path = href;
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/")) {
    if (!cwd) return null;
    path = cwd.replace(/\/+$/, "") + "/" + path.replace(/^\.\//, "");
  }
  return "api/local-image?path=" + encodeURIComponent(path);
}

/**
 * A web or mail link opens in a new tab. A link whose target is an artifact (`job:`, `thread:`, `wiki:`, `file:`, a bare absolute path,
 * or a chat permalink URL) becomes a button carrying the stored target form; the view's click handler opens it in the reader or the
 * thread. Relative links and other schemes stay as marked text with the target on hover.
 */
const WEB_LINK = /^(https?:\/\/|mailto:)/i;
function artifactTarget(href: string): string | null {
  const target = normalizeArtifactTarget(href);
  if (!target) return null;
  return WEB_LINK.test(href) ? (target.startsWith("thread:") ? target : null) : target;
}

const marked = new Marked({
  gfm: true,
  async: false,
  // Raw HTML is escaped, so a literal <table> in the output always came from the table renderer.
  hooks: { postprocess: html => html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>") },
  renderer: {
    html({ text }) { return escapeHtml(text); },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const tip = escapeHtml(title ? `${title} (${href})` : href);
      const target = artifactTarget(href);
      if (target) return `<button type="button" class="artifact-link" data-target="${escapeHtml(target)}" title="${tip}">${text}</button>`;
      if (WEB_LINK.test(href)) return `<a href="${escapeHtml(href)}" title="${tip}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return `<span class="path-link" title="${tip}">${text}</span>`;
    },
    image({ href, title, text }) {
      const src = imageSource(href, renderCwd);
      if (!src) return `<span class="inert-image">Image: ${escapeHtml(text || href)}</span>`;
      const label = escapeHtml(title || text || href);
      return `<img class="reply-image" src="${escapeHtml(src)}" alt="${escapeHtml(text)}" title="${label}" loading="lazy" data-source="${escapeHtml(href)}">`;
    },
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s/)[0] ?? "";
      if (DIAGRAM_LANGUAGES.has(language.toLowerCase())) {
        return `<div class="code-block diagram-block" data-diagram="${escapeHtml(language.toLowerCase())}"><div class="code-head"><span class="code-lang">${escapeHtml(language)}</span>` +
          `<span class="diagram-switch" role="group" aria-label="Show"><button type="button" data-diagram-view="diagram" aria-pressed="true">Diagram</button><button type="button" data-diagram-view="source" aria-pressed="false">Source</button><button type="button" data-diagram-expand>Expand</button></span>` +
          `<button type="button" class="copy-button" data-copy>Copy</button></div><div class="diagram-slot"></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
      }
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(language)}</span><button type="button" class="copy-button" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
    },
    checkbox({ checked }) { return `<span class="checkbox">${checked ? "[x]" : "[ ]"}</span> `; },
  },
});

const cache = new Map<string, string>();
const CACHE_LIMIT = 4000;

export function renderMarkdown(text: string, cwd = ""): string {
  const key = cwd + "\0" + text;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  renderCwd = cwd;
  let html: string;
  try { html = marked.parse(text, { async: false }); } finally { renderCwd = ""; }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

/** The owner's own bubble: links, inline code, bold and line breaks only; no lists, headings or blocks. */
export function renderInline(text: string): string {
  const key = "inline\0" + text;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const html = marked.parseInline(text.replace(/\r\n?/g, "\n"), { async: false, breaks: true });
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

/**
 * A chat reply split for the bubble: prose runs stay in the bubble; an image that is a paragraph of its own, or a diagram fence,
 * becomes a card under it. `closed` is false for a diagram fence the reply is still writing (no closing fence yet).
 */
export type BubbleBlock = { kind: "prose"; text: string } | { kind: "image"; text: string } | { kind: "diagram"; text: string; closed: boolean };
const FENCE_CLOSED = /\n[ \t]{0,3}(`{3,}|~{3,})[ \t]*\n?$/;
const isDiagram = (token: Token): boolean => token.type === "code" && DIAGRAM_LANGUAGES.has(((token as { lang?: string }).lang ?? "").split(/\s/)[0]!.toLowerCase());
function isLoneImage(token: Token): boolean {
  if (token.type !== "paragraph") return false;
  const parts = ((token as { tokens?: Token[] }).tokens ?? []).filter(part => !(part.type === "text" && !part.raw.trim()));
  return parts.length === 1 && parts[0]!.type === "image";
}
export function bubbleBlocks(text: string): BubbleBlock[] {
  const blocks: BubbleBlock[] = [];
  let prose = "";
  const flush = () => { if (prose.trim()) blocks.push({ kind: "prose", text: prose }); prose = ""; };
  for (const token of marked.lexer(text)) {
    if (isDiagram(token)) { flush(); blocks.push({ kind: "diagram", text: token.raw, closed: FENCE_CLOSED.test(token.raw) }); }
    else if (isLoneImage(token)) { flush(); blocks.push({ kind: "image", text: token.raw }); }
    else prose += token.raw;
  }
  flush();
  return blocks;
}

/** The artifact target of a clicked `.artifact-link` button in rendered markdown, or null. */
export function artifactFromClick(event: MouseEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>("button.artifact-link");
  if (!button?.dataset.target) return null;
  event.preventDefault();
  return button.dataset.target;
}

export function copyFromClick(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest("[data-copy]");
  if (!button) return false;
  const block = button.closest(".code-block");
  const code = block?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  });
  event.preventDefault();
  return true;
}

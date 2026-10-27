import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { hueFor } from "./hash";

/**
 * Markdown for messages, reports and docs. Output is sanitized HTML that Markdown.svelte mounts and hydrates
 * (mermaid blocks, copy buttons, image lightbox, link and chip clicks).
 *
 * Beyond GFM it renders:
 * - wiki links: `[[path]]`, `[[path|label]]`, `wiki:path`, and links to `<wiki>/page/<path>`;
 * - artifact links: `job:<name>`, `thread:<id>`, `file:<path>`, carried as `data-target` for the page to open;
 * - board ids such as p12, t3 and d9 when the context names them, as the same chip IdChip draws;
 * - @mentions of known names, as the same chip MentionChip draws;
 * - images from https, data URLs, and local files through the chat server's /api/local-image.
 */

export type MarkdownContext = {
  /** The chat's board ids and their titles; ids not in the map stay text. */
  board?: { chatId: string; titles: ReadonlyMap<string, string> } | null;
  /** Mention targets by lower-case name, without the @. */
  mentions?: ReadonlyMap<string, { id: string; kind: "person" | "agent" | "channel"; self?: boolean }> | null;
  /** Folder that relative image paths resolve against. */
  cwd?: string;
  /** Chat message mode: bold renders as text and headings as paragraphs. */
  plain?: boolean;
};

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const DEFAULT_WIKI = "https://us-metal02-dev.tail0c093d.ts.net:5176";
/** The wiki origin: `<body data-wiki>` from the server, VITE_WIKI_ORIGIN, or the box default. */
export function wikiOrigin(): string {
  const fromBody = typeof document !== "undefined" ? document.body?.dataset.wiki : undefined;
  return (fromBody || (import.meta.env.VITE_WIKI_ORIGIN as string | undefined) || DEFAULT_WIKI).replace(/\/+$/, "");
}
export const wikiUrl = (path: string): string => `${wikiOrigin()}/page/${path.replace(/^\/+/, "")}`;

/** Where an image loads from, or null to show it as text. */
export function imageSource(href: string, cwd = ""): string | null {
  if (/^https:\/\//i.test(href) || /^data:image\/(png|jpeg|gif|webp);/i.test(href)) return href;
  if (/^\/api\//.test(href)) return href;
  let path = href;
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  } else if (/^file:/i.test(path)) path = path.slice(5);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/")) {
    if (!cwd) return null;
    path = `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
  }
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const WEB_LINK = /^(?:https?:\/\/|mailto:)/i;
const ARTIFACT = /^(?:job|thread|file|wiki):/i;

/** Normalize a link target: wiki URLs become `wiki:<path>`, artifact forms stay, anything else is null. */
export function artifactTarget(href: string): string | null {
  const wiki = /^https?:\/\/[^/\s]+:5176\/(?:page|raw)\/([^?#\s]+)/i.exec(href);
  if (wiki) return `wiki:${decodeURIComponent(wiki[1]!)}`;
  if (ARTIFACT.test(href)) return href.replace(/^(\w+):/, (m) => m.toLowerCase());
  if (/^\/(?:home|Users|tmp)\//.test(href)) return `file:${href}`;
  return null;
}

function linkIcon(target: string): string {
  const kind = target.split(":")[0];
  const path =
    kind === "wiki"
      ? '<path d="M5.5 3.5h6l3.5 3.5v9.5h-9.5z"/><path d="M11.5 3.5V7H15"/>'
      : kind === "job"
        ? '<rect x="4" y="6.5" width="12" height="9" rx="3"/><path d="M10 3.5v3"/>'
        : kind === "thread"
          ? '<path d="M4 4.5h12M4 8.5h8"/><path d="M6.5 12v2a2 2 0 0 0 2 2H16"/>'
          : '<path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3.5l1.5 2h5A1.5 1.5 0 0 1 16.5 8v6.5A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z"/>';
  return `<svg class="link-icon" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function artifactLink(target: string, inner: string): string {
  const href = target.startsWith("wiki:") ? ` href="${escapeHtml(wikiUrl(target.slice(5)))}" target="_blank" rel="noopener noreferrer"` : ' href="#" role="link"';
  return `<a class="artifact-link" data-target="${escapeHtml(target)}" title="${escapeHtml(target)}"${href}>${linkIcon(target)}${inner}</a>`;
}

function imageTag(src: string, alt: string, source: string, thumb = false): string {
  return `<img class="md-image${thumb ? " thumb" : ""}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="${escapeHtml(source)}" loading="lazy" data-source="${escapeHtml(source)}">`;
}

let ctx: MarkdownContext = {};

const wikiLinks: TokenizerAndRendererExtension = {
  name: "wikiLink",
  level: "inline",
  start(src) {
    const i = src.search(/\[\[|(?:^|[^\w/])wiki:/);
    return i < 0 ? undefined : src[i] === "[" ? i : i + (src.slice(i).startsWith("wiki:") ? 0 : 1);
  },
  tokenizer(src) {
    const bracket = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (bracket) return { type: "wikiLink", raw: bracket[0], path: bracket[1]!.trim(), label: (bracket[2] ?? bracket[1]!).trim() };
    if (this.lexer.state.inLink) return undefined;
    const bare = /^wiki:([^\s<>()[\]`"']+)/.exec(src);
    if (!bare) return undefined;
    const raw = bare[0].replace(/[.,;:!?]+$/, "");
    return { type: "wikiLink", raw, path: raw.slice(5), label: raw };
  },
  renderer(token) {
    const path = String(token.path);
    if (IMAGE_FILE.test(path)) return imageTag(`${wikiOrigin()}/raw/${path}`, String(token.label), `wiki:${path}`, true);
    return artifactLink(`wiki:${path}`, escapeHtml(String(token.label)));
  },
};

const boardIds: TokenizerAndRendererExtension = {
  name: "boardId",
  level: "inline",
  start(src) {
    const m = /(^|[^\w])[pstd]\d+\b/.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src, tokens) {
    const board = ctx.board;
    if (!board || this.lexer.state.inLink) return undefined;
    const m = /^[pstd]\d+\b/.exec(src);
    if (!m || !board.titles.has(m[0]) || /\w$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    return { type: "boardId", raw: m[0], id: m[0] };
  },
  renderer(token) {
    const id = String(token.id);
    const chatId = ctx.board?.chatId ?? "";
    const title = ctx.board?.titles.get(id) ?? id;
    return `<button type="button" class="id-chip" style="--h:${hueFor(`${chatId}:${id}`)}" data-board-id="${escapeHtml(id)}" data-chat-id="${escapeHtml(chatId)}" title="${escapeHtml(title)}"><span class="dot"></span>${escapeHtml(id)}</button>`;
  },
};

const mentions: TokenizerAndRendererExtension = {
  name: "mention",
  level: "inline",
  start(src) {
    const m = /(^|[^\w])@[\w-]/.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src, tokens) {
    const names = ctx.mentions;
    if (!names || this.lexer.state.inLink || /\w$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const m = /^@([\w][\w .-]{0,40})/.exec(src);
    if (!m) return undefined;
    let name = m[1]!;
    while (name && !names.has(name.toLowerCase())) name = name.replace(/[\s.-]*[^\s.-]*$/, "");
    if (!name) return undefined;
    const hit = names.get(name.toLowerCase())!;
    return { type: "mention", raw: `@${name}`, name, id: hit.id, kind: hit.kind, self: !!hit.self };
  },
  renderer(token) {
    const kind = String(token.kind);
    const text = kind === "person" ? `@${String(token.name)}` : String(token.name);
    return `<button type="button" class="inline-chip mention${token.self ? " self" : ""}" data-mention-kind="${escapeHtml(kind)}" data-mention-id="${escapeHtml(String(token.id))}"><span class="text">${escapeHtml(text)}</span></button>`;
  },
};

const marked = new Marked({
  gfm: true,
  async: false,
  extensions: [wikiLinks, boardIds, mentions],
  hooks: {
    postprocess: (html) => html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>"),
  },
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const target = artifactTarget(href);
      if (target) {
        const path = target.replace(/^\w+:/, "");
        if (IMAGE_FILE.test(path)) {
          const src = target.startsWith("wiki:") ? `${wikiOrigin()}/raw/${path}` : imageSource(path, ctx.cwd);
          if (src) return imageTag(src, tokens.map((t) => t.raw).join("") || path, href, true);
        }
        return artifactLink(target, text);
      }
      if (WEB_LINK.test(href)) return `<a href="${escapeHtml(href)}" title="${escapeHtml(title ?? href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return `<span class="path-link" title="${escapeHtml(href)}">${text}</span>`;
    },
    image({ href, title, text }) {
      const target = /^(?:wiki|file):/.test(href) ? artifactTarget(href) : null;
      const src = target?.startsWith("wiki:") ? `${wikiOrigin()}/raw/${target.slice(5)}` : imageSource(href, ctx.cwd);
      if (!src) return `<span class="inert-image">Image: ${escapeHtml(text || href)}</span>`;
      return imageTag(src, text, title || href);
    },
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s/)[0]!.toLowerCase();
      if (language === "mermaid") {
        return `<div class="code-block diagram-block" data-diagram="mermaid"><div class="code-head"><span class="code-lang">mermaid</span><span class="code-actions"><button type="button" data-diagram-toggle>Source</button><button type="button" data-copy>Copy</button></span></div><div class="diagram-slot"></div><pre hidden><code>${escapeHtml(text)}</code></pre></div>\n`;
      }
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(language)}</span><span class="code-actions"><button type="button" data-copy>Copy</button></span></div><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre></div>\n`;
    },
    checkbox({ checked }) {
      return `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
    },
    strong({ tokens }) {
      return ctx.plain ? this.parser.parseInline(tokens) : false;
    },
    heading({ tokens }) {
      return ctx.plain ? `<p>${this.parser.parseInline(tokens)}</p>\n` : false;
    },
  },
});

const PURIFY = {
  ADD_ATTR: ["target", "data-target", "data-board-id", "data-chat-id", "data-mention-kind", "data-mention-id", "data-copy", "data-diagram", "data-diagram-toggle", "data-source"],
  ADD_TAGS: ["button"],
};

function sanitize(html: string): string {
  return typeof window === "undefined" ? html : DOMPurify.sanitize(html, PURIFY);
}

const cache = new Map<string, string>();
function cached(key: string, make: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = make();
  cache.set(key, html);
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
  return html;
}
function contextKey(c: MarkdownContext): string {
  return [c.plain ? 1 : 0, c.cwd ?? "", c.board ? `${c.board.chatId}:${c.board.titles.size}` : "", c.mentions ? c.mentions.size : ""].join("|");
}

/** Block markdown to sanitized HTML. */
export function renderMarkdown(text: string, context: MarkdownContext = {}): string {
  return cached(`b${contextKey(context)}\0${text}`, () => {
    ctx = context;
    try {
      return sanitize(marked.parse(text, { async: false }));
    } finally {
      ctx = {};
    }
  });
}

/** Inline markdown only (links, code, bold, chips, line breaks), for one-line rows and the owner's own bubbles. */
export function renderInline(text: string, context: MarkdownContext = {}): string {
  return cached(`i${contextKey(context)}\0${text}`, () => {
    ctx = context;
    try {
      return sanitize(marked.parseInline(text.replace(/\r\n?/g, "\n"), { async: false, breaks: true }));
    } finally {
      ctx = {};
    }
  });
}

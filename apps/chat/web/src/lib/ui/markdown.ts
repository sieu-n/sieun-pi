import DOMPurify from "dompurify";
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";
import { hueFor } from "./hash";
import { ICONS } from "./icons";

/**
 * Markdown for messages, reports and docs. Output is sanitized HTML that Markdown.svelte mounts and hydrates
 * (mermaid blocks, copy buttons, image lightbox, link and chip clicks).
 *
 * Beyond GFM it renders:
 * - wiki links: `[[path]]`, `[[path|label]]`, `wiki:path`, and links to `<wiki>/page/<path>`;
 * - artifact links: `job:<name>`, `thread:<id>`, `file:<path>`, carried as `data-target` for the page to open;
 * - board ids such as p12, t3 and d9 when the context names them, as the same chip IdChip draws;
 * - @mentions of known names, as the same chip MentionChip draws;
 * - images from https, data URLs, and local files through the chat server's /api/local-image, and a bare https image URL as the image;
 * - file paths in code spans or bare text (`apps/chat/server/http.ts:42`) as a pill that copies the path;
 * - GitHub pull request, issue and commit URLs as a compact card, and other web links with the site's icon and domain;
 * - GitHub callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), task lists, and `<details>`/`<summary>`;
 * - code blocks with a language label, a copy button and a fold past CODE_FOLD_LINES lines, and mermaid blocks that draw when they scroll into view.
 * Every other raw HTML tag shows as text.
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
  // import.meta.env is Vite's; the node unit tests of this file run without it.
  return (fromBody || (import.meta.env?.VITE_WIKI_ORIGIN as string | undefined) || DEFAULT_WIKI).replace(/\/+$/, "");
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
/** A code block longer than this folds behind "Show all N lines". */
export const CODE_FOLD_LINES = 20;
/** A repo-relative or absolute file path with an extension and an optional `:line`, `:line-line` or `:line:col`. */
const PATH_BODY = String.raw`(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w@.+-]*\/)+[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::\d+(?:[-:]\d+)?)?`;
const FILE_PATH = new RegExp(`^${PATH_BODY}$`);
const PATH_START = new RegExp(`(^|[\\s(])${PATH_BODY}`);
const PATH_AT = new RegExp(`^${PATH_BODY}`);
/** One file name with a line, `markdown.ts:42`, counts as a path inside a code span. */
const FILE_LINE = /^[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}:\d+(?:[-:]\d+)?$/;
/** github.com pull requests, issues and commits, with any tab or anchor after them. */
const GITHUB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/(\d+|[0-9a-f]{7,40})(?=$|[/?#])/i;
const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
const CALLOUT_ICON: Record<string, keyof typeof ICONS> = { note: "info", tip: "info", important: "info", warning: "warning", caution: "warning" };
/** The only raw HTML that renders: a fold and its title, and a line break (in a table cell). Any other tag shows as text. */
const ALLOWED_TAG = /^<(\/?)(details|summary|br)(\s+open(?:="")?)?\s*\/?>$/i;

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

function artifactLink(target: string, inner: string, extraClass = ""): string {
  const kind = target.split(":")[0]!;
  const href = kind === "wiki" ? ` href="${escapeHtml(wikiUrl(target.slice(5)))}" target="_blank" rel="noopener noreferrer"` : ' href="#" role="link"';
  const title = kind === "file" ? `${target.slice(5)} (click to copy the path)` : target;
  return `<a class="artifact-link ${kind}-link${extraClass}" data-target="${escapeHtml(target)}" title="${escapeHtml(title)}"${href}>${linkIcon(target)}<span class="link-text">${inner}</span></a>`;
}

/** A file path as a pill that copies it; the text keeps the `:line`. */
const pathPill = (path: string): string => artifactLink(`file:${path}`, escapeHtml(path), " path-pill");

/** A shorter label for a long id: a UUID keeps its first 8 characters, and a job conversation keeps its `:n`. */
function shortId(id: string): string {
  return id.replace(/^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "$1");
}

const GITHUB_MARK =
  '<svg class="gh-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

/** A GitHub pull request, issue or commit as a compact card: repo, number or short sha, and the link text as its title. */
function githubCard(href: string, match: RegExpExecArray, title: string): string {
  const [, owner, repo, kind, id] = match as unknown as [string, string, string, string, string];
  const ref = kind.toLowerCase() === "commit" ? id.slice(0, 7) : `#${id}`;
  const label = kind.toLowerCase() === "pull" ? "Pull request" : kind.toLowerCase() === "issues" ? "Issue" : "Commit";
  return `<a class="gh-card" data-gh="${escapeHtml(kind.toLowerCase())}" href="${escapeHtml(href)}" title="${escapeHtml(`${label} ${ref} in ${owner}/${repo}`)}" target="_blank" rel="noopener noreferrer">${GITHUB_MARK}<span class="gh-repo">${escapeHtml(`${owner}/${repo}`)}</span><span class="gh-ref">${escapeHtml(ref)}</span>${title ? `<span class="gh-title">${title}</span>` : ""}</a>`;
}

/** The host of a web URL without `www.`, or "" when it does not parse. */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A bare URL's label: its host and path, the middle cut when long. */
function urlLabel(href: string): string {
  try {
    const url = new URL(href);
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
    const label = `${url.hostname.replace(/^www\./, "")}${rest}`;
    return label.length > 60 ? `${label.slice(0, 40)}\u2026${label.slice(-16)}` : label;
  } catch {
    return href;
  }
}

/**
 * A web link: GitHub pull requests, issues and commits as a card, a bare image URL as the image, anything else with the site's icon
 * (the favicon, dropped when it fails to load) and, when the text does not say it, the domain.
 */
function webLink(href: string, title: string | null | undefined, text: string, bare: boolean): string {
  const gh = GITHUB.exec(href);
  if (gh) return githubCard(href, gh, bare ? "" : text);
  if (/^https:\/\//i.test(href)) {
    const path = href.replace(/[?#].*$/, "");
    if (IMAGE_FILE.test(path)) return imageTag(href, bare ? "" : text.replace(/<[^>]*>/g, ""), href, !bare);
  }
  const host = /^https?:/i.test(href) ? hostOf(href) : "";
  const icon = host ? `<img class="favicon" src="https://${escapeHtml(host)}/favicon.ico" alt="" width="14" height="14" loading="lazy">` : "";
  const inner = bare && host ? escapeHtml(urlLabel(href)) : text;
  const domain = host && !bare && !text.toLowerCase().includes(host.toLowerCase()) ? `<span class="link-domain">${escapeHtml(host)}</span>` : "";
  return `<a class="web-link" href="${escapeHtml(href)}" title="${escapeHtml(title ?? href)}" target="_blank" rel="noopener noreferrer">${icon}<span class="link-text">${inner}</span>${domain}</a>`;
}

function imageTag(src: string, alt: string, source: string, thumb = false): string {
  return `<img class="md-image${thumb ? " thumb" : ""}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="${escapeHtml(source)}" loading="lazy" data-source="${escapeHtml(source)}">`;
}

/** The same 13 px glyph MentionChip draws, from the shared icon set. */
function chipGlyph(name: "robot" | "hash"): string {
  return `<svg class="icon" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

let ctx: MarkdownContext = {};

const wikiLinks: TokenizerAndRendererExtension = {
  name: "wikiLink",
  level: "inline",
  start(src) {
    const i = src.search(/\[\[|(?:^|[^\w/])(?:wiki|thread|job):/);
    return i < 0 ? undefined : src[i] === "[" || /^(?:wiki|thread|job):/.test(src.slice(i)) ? i : i + 1;
  },
  tokenizer(src, tokens) {
    const bracket = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (bracket) return { type: "wikiLink", raw: bracket[0], path: bracket[1]!.trim(), label: (bracket[2] ?? bracket[1]!).trim() };
    if (this.lexer.state.inLink || /[\w/]$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const bare = /^wiki:([^\s<>()[\]`"']+)/.exec(src);
    if (bare) {
      const raw = bare[0].replace(/[.,;:!?]+$/, "");
      return { type: "wikiLink", raw, path: raw.slice(5), label: raw };
    }
    // A bare `thread:<conversation id>` or `job:<name with no spaces>` link, as the board and the briefs write them.
    const other = /^(thread:[\w-]+(?::\d+)?(?:@\d+)?|job:[^\s<>()[\]`"']+)/.exec(src);
    if (!other) return undefined;
    const raw = other[0].replace(/[.,;:!?]+$/, "");
    return { type: "wikiLink", raw, target: raw, label: raw.startsWith("thread:") ? `thread ${shortId(raw.slice(7))}` : raw.slice(4) };
  },
  renderer(token) {
    if (token.target) return artifactLink(String(token.target), escapeHtml(String(token.label)));
    const path = String(token.path);
    if (IMAGE_FILE.test(path)) return imageTag(`${wikiOrigin()}/raw/${path}`, String(token.label), `wiki:${path}`, true);
    return artifactLink(`wiki:${path}`, escapeHtml(String(token.label)));
  },
};

/**
 * `[label](job:name with spaces)`, the form skills/board/references/owner.md asks for: CommonMark ends a link destination at a space, so the
 * link would fall apart into text and a `job:<first word>` link. A link whose target is an artifact form and holds spaces is read whole here,
 * after legacy/prime/user-history's client markdown.
 */
const SPACED_LINK = /^\[([^\]\n]{1,300})\]\(((?:job|thread|wiki|file):[^()\n]{1,500}?)\)/;
const spacedLinks: TokenizerAndRendererExtension = {
  name: "spacedLink",
  level: "inline",
  start(src) {
    const index = src.search(/\[[^\]\n]{1,300}\]\((?:job|thread|wiki|file):[^()\n]* /);
    return index >= 0 ? index : undefined;
  },
  tokenizer(src) {
    const match = SPACED_LINK.exec(src);
    if (!match || !/\s/.test(match[2]!)) return undefined;
    const target = artifactTarget(match[2]!.trim());
    if (!target) return undefined;
    // The label is link text, so a job name or a bare target in it stays text, as in marked's own links.
    const inLink = this.lexer.state.inLink;
    this.lexer.state.inLink = true;
    try {
      return { type: "spacedLink", raw: match[0], target, tokens: this.lexer.inlineTokens(match[1]!) };
    } finally {
      this.lexer.state.inLink = inLink;
    }
  },
  renderer(token) {
    return artifactLink(String(token.target), this.parser.parseInline(token.tokens ?? []));
  },
};

/** A bare file path with a folder and an extension in running text, such as apps/chat/server/http.ts:42, as a path pill. */
const filePaths: TokenizerAndRendererExtension = {
  name: "filePath",
  level: "inline",
  start(src) {
    const m = PATH_START.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src, tokens) {
    if (this.lexer.state.inLink || /[^\s(]$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const m = PATH_AT.exec(src);
    if (!m) return undefined;
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    if (!FILE_PATH.test(raw) || /^[\w@.+-]/.test(src.slice(raw.length))) return undefined;
    return { type: "filePath", raw, path: raw };
  },
  renderer(token) {
    return pathPill(String(token.path));
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
    if (!/^@\w/.test(src)) return undefined;
    const head = src.slice(1).toLowerCase();
    let key = "";
    for (const known of names.keys()) {
      if (known.length > key.length && head.startsWith(known) && !(/\w$/.test(known) && /^\w/.test(head.slice(known.length)))) key = known;
    }
    if (!key) return undefined;
    const name = src.slice(1, 1 + key.length);
    const hit = names.get(key)!;
    return { type: "mention", raw: `@${name}`, name, id: hit.id, kind: hit.kind, self: !!hit.self };
  },
  renderer(token) {
    const kind = String(token.kind);
    const text = kind === "person" ? `@${String(token.name)}` : String(token.name);
    const glyph = kind === "agent" ? chipGlyph("robot") : kind === "channel" ? chipGlyph("hash") : "";
    return `<button type="button" class="inline-chip mention${token.self ? " self" : ""}" data-mention-kind="${escapeHtml(kind)}" data-mention-id="${escapeHtml(String(token.id))}">${glyph}<span class="text">${escapeHtml(text)}</span></button>`;
  },
};

const marked = new Marked({
  gfm: true,
  async: false,
  extensions: [spacedLinks, wikiLinks, filePaths, boardIds, mentions],
  hooks: {
    postprocess: (html) => html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>"),
  },
  walkTokens(token) {
    // A GitHub callout: a quote whose first line is `[!NOTE]` and the like. The marker comes off the first paragraph.
    if (token.type !== "blockquote") return;
    const quote = token as Tokens.Blockquote & { callout?: string };
    const first = quote.tokens[0];
    if (first?.type !== "paragraph") return;
    const marker = CALLOUT.exec((first as Tokens.Paragraph).text);
    if (!marker) return;
    quote.callout = marker[1]!.toLowerCase();
    const inline = (first as Tokens.Paragraph).tokens;
    const lead = inline[0];
    if (lead?.type === "text") {
      const text = lead as Tokens.Text;
      text.text = text.text.replace(/^\[![a-z]+\][ \t]*\n?/i, "");
      text.raw = text.raw.replace(/^\[![a-z]+\][ \t]*\n?/i, "");
      if (!text.text) inline.shift();
    }
    if (!inline.length) quote.tokens.shift();
  },
  renderer: {
    html({ text }) {
      return text.split(/(<\/?[a-z][^<>]*>)/i).map((part) => (ALLOWED_TAG.test(part) ? part.toLowerCase().replace(/\s*\/?>$/, ">") : escapeHtml(part))).join("");
    },
    blockquote(token) {
      const kind = (token as Tokens.Blockquote & { callout?: string }).callout;
      if (!kind) return false;
      const title = kind.charAt(0).toUpperCase() + kind.slice(1);
      const icon = `<svg class="callout-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[CALLOUT_ICON[kind]!]}</svg>`;
      return `<div class="callout callout-${kind}" role="note" data-callout="${kind}"><p class="callout-title">${icon}${title}</p>${this.parser.parse(token.tokens)}</div>\n`;
    },
    listitem(item) {
      if (!item.task) return false;
      return `<li class="task-item${item.checked ? " done" : ""}">${this.parser.parse(item.tokens)}</li>\n`;
    },
    codespan({ text }) {
      return FILE_PATH.test(text) || FILE_LINE.test(text) ? pathPill(text) : false;
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
      const raw = tokens.map((t) => t.raw).join("");
      if (WEB_LINK.test(href)) return webLink(href, title, text, raw === href || `mailto:${raw}` === href);
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
        return `<div class="code-block diagram-block" data-diagram="mermaid"><div class="code-head"><span class="code-lang">diagram</span><span class="code-actions"><button type="button" data-diagram-expand>Expand</button><button type="button" data-diagram-toggle>Source</button><button type="button" data-copy>Copy</button></span></div><p class="diagram-error" hidden></p><div class="diagram-slot"></div><pre hidden><code class="language-mermaid">${escapeHtml(text)}</code></pre></div>\n`;
      }
      const lines = text.split("\n").length;
      const fold = lines > CODE_FOLD_LINES;
      const more = fold ? `<button type="button" class="code-more" data-expand data-lines="${lines}" aria-expanded="false">Show all ${lines} lines</button>` : "";
      return `<div class="code-block${fold ? " folded" : ""}"><div class="code-head"><span class="code-lang">${escapeHtml(language || "text")}</span><span class="code-actions"><button type="button" data-copy>Copy</button></span></div><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre>${more}</div>\n`;
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
  ADD_ATTR: [
    "target", "data-target", "data-board-id", "data-chat-id", "data-mention-kind", "data-mention-id", "data-copy", "data-diagram", "data-diagram-toggle", "data-diagram-expand",
    "data-source", "data-expand", "data-lines", "data-callout", "data-gh",
  ],
  ADD_TAGS: ["button", "details", "summary"],
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

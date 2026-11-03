import DOMPurify from "dompurify";
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";
import { emojiOf } from "../api/shared/emoji";
import { hueFor } from "./hash";
import { ICONS } from "./icons";

/**
 * Markdown for messages, reports and docs. Output is sanitized HTML that Markdown.svelte mounts and hydrates
 * (mermaid blocks, copy buttons, image lightbox, link and chip clicks).
 *
 * Beyond GFM it renders:
 * - wiki links: `[[path]]`, `[[path|label]]`, `wiki:path`, and links to `<wiki>/page/<path>` or `https://<host>:5184/wiki/<path>`;
 * - artifact links: `job:<name>`, `thread:<id>`, `file:<path>`, carried as `data-target` for the page to open, also bare or alone in a code span;
 * - the job names the context lists, as a whole word or alone in a code span, as job links, after legacy/prime/user-history's client;
 * - wiki content paths (`apps/llm-wiki/content/<path>`, `~/.pi/wiki/content/<path>`) as wiki links, and bare absolute paths as path pills;
 * - links into this app (`https://<host>:5184/#/c/<id>`) as in-app links that open the conversation in place;
 * - loopback links (`http://localhost:5180/x`, and `localhost:5180/x` written bare) with their port and a server icon in place of a favicon;
 * - board ids such as p12, t3 and d9 when the context names them, as the same chip IdChip draws;
 * - @mentions of known names, as the same chip MentionChip draws;
 * - images from https, data URLs, and local files through the chat server's /api/local-image, and a bare https image URL as the image;
 * - file paths in code spans or bare text (`apps/chat/server/http.ts:42`) as a pill that copies the path;
 * - GitHub pull request, issue and commit URLs as a compact card, and other web links with the site's icon and domain;
 * - GitHub callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), task lists, and `<details>`/`<summary>`;
 * - code blocks with a language label, a copy button and a fold past CODE_FOLD_LINES lines, and mermaid blocks that draw when they scroll into view;
 * - Slack emoji names such as `:eyes:` as the emoji, and in chat message mode every line break as a break, as Slack shows a post.
 * Every other raw HTML tag shows as text.
 */

export type MarkdownContext = {
  /** The chat's board ids and their titles; ids not in the map stay text. */
  board?: { chatId: string; titles: ReadonlyMap<string, string> } | null;
  /** Mention targets by lower-case name, without the @. */
  mentions?: ReadonlyMap<string, { id: string; kind: "person" | "agent" | "channel"; self?: boolean }> | null;
  /** Folder that relative image paths resolve against. */
  cwd?: string;
  /** Chat message mode: bold renders as text, headings as paragraphs, and a single line break as a break. */
  plain?: boolean;
  /** The names of the jobs whose bare mention becomes a job link. */
  jobs?: readonly string[];
  /** Per post author (an agent id): its own board and jobs, which `withAuthor` puts in place of the room's for that author's posts. */
  authors?: ReadonlyMap<string, AuthorContext> | null;
};
export type AuthorContext = { board?: MarkdownContext["board"]; jobs?: readonly string[] };

/** The context for one post: its author's board and jobs when the room's context has them, else the room's own. */
export function withAuthor(context: MarkdownContext, authorId: string): MarkdownContext {
  const own = context.authors?.get(authorId);
  if (!own) return context;
  return { ...context, board: own.board ?? context.board, jobs: own.jobs ?? context.jobs };
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const DEFAULT_WIKI = "https://us-metal02-dev.tail0c093d.ts.net:5184/wiki";
/** The wiki base: `<body data-wiki>`, which the client sets from the server's `Me.wikiBase`, VITE_WIKI_ORIGIN, or the box default. */
export function wikiOrigin(): string {
  const fromBody = typeof document !== "undefined" ? document.body?.dataset.wiki : undefined;
  // import.meta.env is Vite's; the node unit tests of this file run without it.
  return (fromBody || (import.meta.env?.VITE_WIKI_ORIGIN as string | undefined) || DEFAULT_WIKI).replace(/\/+$/, "");
}
export const wikiUrl = (path: string): string => `${wikiOrigin()}/${path.replace(/^\/+/, "")}`;

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

/** The wiki content folder in a path an agent wrote: auto-sns-agent's old `apps/llm-wiki/content/`, or `~/.pi/wiki/content/` since 11-03. */
const WIKI_CONTENT = /^(?:(?:~|\/(?:home|Users)\/[^/\s]+)\/\.pi\/wiki\/content\/|(?:\/[^\s]*?\/)?apps\/llm-wiki\/content\/)/;
/** A bare absolute path (`/home/x/y`, `~/x`) with at least one folder; a lone `/word` such as `/s` or `and/or` is not one. */
const ABS_PATH = /^(?:~\/|\/(?=[A-Za-z][^\s/]*\/[^\s/]))[^\s<>()[\]`"'*|]+/;
const ABS_PATH_START = /(^|[\s(])(?:~\/|\/[A-Za-z][^\s/]*\/[^\s/])/;
/** A loopback address written without its scheme: `localhost:5180/campaigns`, `127.0.0.1:8080`. */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(?:\/[^\s<>()`"']*)?/;
const LOOPBACK_START = /(^|[\s(])(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}/;
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * The content path of a wiki page in every form a chat writes after `wiki:`: `<path>`, `/<path>`, `page/<path>`, `raw/<path>`, any of them
 * under `wiki/`, a `<host>:<port>` in front, or a whole page URL (`https://<host>:5176/page/<path>`, `https://<host>:5184/wiki/<path>`).
 * The `?query` and `#hash` go, since a page is its path. Null when it names no page. After legacy/prime/user-history's `wikiLinkPath`.
 */
export function wikiLinkPath(text: string): string | null {
  let path = text;
  const url = /^https?:\/\//i.test(text);
  if (url) {
    try {
      path = new URL(text).pathname;
    } catch {
      return null;
    }
  } else path = text.replace(/[?#][\s\S]*$/, "").replace(/^(?:[\w-]+\.)*[\w-]+:\d+(?=\/)/, "");
  try {
    path = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const route = /^(?:wiki\/(?!api\/)(?:page\/|raw\/)?|page\/|raw\/)/.exec(path);
  if (url && !route) return null;
  const clean = route ? path.slice(route[0].length) : path;
  if (!clean || /\s/.test(clean) || clean.split("/").some((part) => part === ".." || part === ".")) return null;
  return clean;
}

/** A path into the wiki content folder as `wiki:<path>`, or null for any other path. */
function contentTarget(path: string): string | null {
  const content = WIKI_CONTENT.exec(path);
  return content && path.length > content[0].length ? `wiki:${path.slice(content[0].length)}` : null;
}

/** Normalize a link target: wiki URLs and content paths become `wiki:<path>`, artifact forms stay, anything else is null. */
export function artifactTarget(href: string): string | null {
  const wiki = /^https?:\/\/[^/\s]+(?::5176\/(?:wiki\/)?(?:page|raw)\/|:5184\/wiki\/(?:page\/|raw\/)?(?!api\/))([^?#\s]+)/i.exec(href);
  if (wiki) return `wiki:${decodeURIComponent(wiki[1]!)}`;
  if (/^wiki:/i.test(href)) {
    const path = wikiLinkPath(href.slice(5));
    return path ? `wiki:${path}` : null;
  }
  if (/^file:/i.test(href)) return contentTarget(href.slice(5)) ?? `file:${href.slice(5)}`;
  if (ARTIFACT.test(href)) return href.replace(/^(\w+):/, (m) => m.toLowerCase());
  if (/^(?:\/(?:home|Users|tmp)\/|~\/)/.test(href)) return contentTarget(href) ?? `file:${href}`;
  return null;
}

/** A target that a bare word or a lone code span names: an artifact form, a wiki content path or an absolute path. */
function bareTarget(text: string): string | null {
  if (/^(?:wiki|job|thread):\S/.test(text)) return artifactTarget(text);
  if (/^(?:~\/|\/)/.test(text) && ABS_PATH.exec(text)?.[0] === text) return contentTarget(text) ?? `file:${text}`;
  return contentTarget(text);
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
    const label = `${url.host.replace(/^www\./, "")}${rest}`;
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
  const app = appLink(href, text, bare);
  if (app) return app;
  if (LOOPBACK_HOST.test(hostOf(href))) {
    const inner = bare ? escapeHtml(urlLabel(href)) : text;
    return `<a class="web-link local-link" href="${escapeHtml(href)}" title="${escapeHtml(title ?? href)}" target="_blank" rel="noopener noreferrer">${SERVER_ICON}<span class="link-text">${inner}</span></a>`;
  }
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

const SERVER_ICON =
  '<svg class="link-icon" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4" width="13" height="5" rx="1.5"/><rect x="3.5" y="11" width="13" height="5" rx="1.5"/><path d="M6.5 6.5h.01M6.5 13.5h.01"/></svg>';

/**
 * A link into this app, `https://<host>:5184/#/c/<conversation>` or the same origin, opens in place: its href keeps only the hash, so the
 * router takes it and no tab opens. A bare one is labeled with the conversation's name when the context knows it.
 */
function appLink(href: string, text: string, bare: boolean): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const here = typeof location !== "undefined" && url.origin === location.origin;
  if (!(here || url.port === "5184") || !url.hash.startsWith("#/") || url.pathname.startsWith("/wiki")) return null;
  const conversation = /^#\/c\/([^/?#]+)/.exec(url.hash)?.[1];
  const label = bare ? escapeHtml(conversation ? conversationName(decodeURIComponent(conversation)) : url.hash.slice(2)) : text;
  return `<a class="artifact-link app-link" href="${escapeHtml(url.hash)}" title="${escapeHtml(href)}">${linkIcon("thread:")}<span class="link-text">${label}</span></a>`;
}

/** `#vent-dev` for a channel and the agent's name for its DM, when the context's mentions name it; else the id. */
function conversationName(id: string): string {
  const agent = id.startsWith("dm_") ? `ag_${id.slice(3)}` : id;
  for (const [name, hit] of ctx.mentions ?? []) {
    if (hit.id === id) return hit.kind === "channel" ? `#${name}` : name;
    if (hit.id === agent) return name;
  }
  return id;
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

/**
 * A bare path in running text: one with a folder and an extension, such as apps/chat/server/http.ts:42, or any absolute one, such as
 * /home/sieun/work/post-parity/, as a path pill; a path into the wiki content folder as a wiki link; an absolute image path as the image.
 */
const filePaths: TokenizerAndRendererExtension = {
  name: "filePath",
  level: "inline",
  start(src) {
    const indexes = [PATH_START.exec(src), ABS_PATH_START.exec(src)].filter((m) => !!m).map((m) => m.index + m[1]!.length);
    return indexes.length ? Math.min(...indexes) : undefined;
  },
  tokenizer(src, tokens) {
    if (this.lexer.state.inLink || /[^\s(]$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const m = PATH_AT.exec(src);
    const raw = m?.[0].replace(/[.,;:!?]+$/, "");
    if (raw && FILE_PATH.test(raw) && !/^[\w@.+-]/.test(src.slice(raw.length))) {
      const target = /^(?:~\/|\/)/.test(raw) ? artifactTarget(raw) : contentTarget(raw);
      return { type: "filePath", raw, path: raw, target: target?.startsWith("wiki:") || (target && IMAGE_FILE.test(raw)) ? target : null };
    }
    const abs = ABS_PATH.exec(src)?.[0].replace(/[.,;:!?]+$/, "");
    if (!abs) return undefined;
    const target = artifactTarget(abs);
    return { type: "filePath", raw: abs, path: abs, target: target?.startsWith("wiki:") || IMAGE_FILE.test(abs) ? target : null };
  },
  renderer(token) {
    const path = String(token.path);
    const target = token.target ? String(token.target) : null;
    if (target && IMAGE_FILE.test(path)) {
      const src = target.startsWith("wiki:") ? `${wikiOrigin()}/raw/${target.slice(5)}` : imageSource(path, ctx.cwd);
      if (src) return imageTag(src, path.split("/").at(-1) ?? path, path, true);
    }
    return target ? artifactLink(target, escapeHtml(path)) : pathPill(path);
  },
};

/** `localhost:5180/campaigns` written without its scheme, as the same loopback link `http://localhost:5180/campaigns` gets. */
const loopbackLinks: TokenizerAndRendererExtension = {
  name: "loopbackLink",
  level: "inline",
  start(src) {
    const m = LOOPBACK_START.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src, tokens) {
    if (this.lexer.state.inLink || /[^\s(]$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const raw = LOOPBACK.exec(src)?.[0].replace(/[.,;:!?]+$/, "");
    return raw ? { type: "loopbackLink", raw } : undefined;
  },
  renderer(token) {
    return webLink(`http://${String(token.raw)}`, null, escapeHtml(String(token.raw)), true);
  },
};

/** A job name list's join, kept per list, since marked asks `start` at each inline token and a room's agents had 349 jobs on 11-03. */
const joinedNames = new WeakMap<readonly string[], string>();
function namesKey(names: readonly string[]): string {
  let key = joinedNames.get(names);
  if (key === undefined) {
    key = names.join("\u0001");
    joinedNames.set(names, key);
  }
  return key;
}

const jobPatterns = new Map<string, { start: RegExp; at: RegExp }>();
/** The start and match patterns for a list of job names, longest name first, so a name that starts another loses to it. */
function jobPattern(names: readonly string[]): { start: RegExp; at: RegExp } | null {
  if (!names.length) return null;
  const key = namesKey(names);
  let hit = jobPatterns.get(key);
  if (!hit) {
    const alt = [...new Set(names)].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    hit = { start: new RegExp(`(^|[^\\w-])(?:${alt})(?![\\w-])`), at: new RegExp(`^(?:${alt})(?![\\w-])`) };
    jobPatterns.set(key, hit);
    if (jobPatterns.size > 50) jobPatterns.delete(jobPatterns.keys().next().value!);
  }
  return hit;
}

/**
 * A job of the context named as a whole word becomes a job link. A name inside a word or a hyphenated word, inside a link, or in quotes
 * (the chat quoting it, not pointing at the job) stays text. After legacy/prime/user-history's `jobMentions`.
 */
const jobNames: TokenizerAndRendererExtension = {
  name: "jobName",
  level: "inline",
  start(src) {
    const m = jobPattern(ctx.jobs ?? [])?.start.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src, tokens) {
    const pattern = jobPattern(ctx.jobs ?? []);
    if (!pattern || this.lexer.state.inLink) return undefined;
    const m = pattern.at.exec(src);
    if (!m) return undefined;
    const before = tokens.at(-1)?.raw ?? "";
    const after = src.slice(m[0].length);
    if (/[\w-]$/.test(before) || /["\u201c]$/.test(before) || (/['\u2018]$/.test(before) && /^['\u2019]/.test(after))) return undefined;
    return { type: "jobName", raw: m[0], name: m[0] };
  },
  renderer(token) {
    return artifactLink(`job:${String(token.name)}`, escapeHtml(String(token.name)));
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

/** A Slack emoji name, `:white_check_mark:`, as its emoji; a name the table does not know stays text. */
const shortcodes: TokenizerAndRendererExtension = {
  name: "shortcode",
  level: "inline",
  start(src) {
    const m = /:[\w+-]+:/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^:([\w+-]+):/.exec(src);
    const hit = m ? emojiOf(m[1]!) : undefined;
    return m && hit ? { type: "shortcode", raw: m[0], char: hit.char, name: m[1] } : undefined;
  },
  renderer(token) {
    return `<span class="emoji" title=":${escapeHtml(String(token.name))}:">${escapeHtml(String(token.char))}</span>`;
  },
};

const marked = new Marked({
  gfm: true,
  async: false,
  extensions: [spacedLinks, wikiLinks, filePaths, loopbackLinks, boardIds, jobNames, mentions, shortcodes],
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
    if (inline[0]?.type === "br") inline.shift();
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
      // A code span that is exactly one target or one job name is its link, since the chats write `wiki:<path>` and job names in backticks.
      const target = ctx.jobs?.includes(text) ? `job:${text}` : bareTarget(text);
      if (target && !(target.startsWith("file:") && IMAGE_FILE.test(target))) return artifactLink(target, escapeHtml(text));
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

/** One DOMPurify set up once, since `sanitize(html, config)` parses the config again on every post. */
let purifier: ReturnType<typeof DOMPurify> | undefined;
function sanitize(html: string): string {
  if (typeof window === "undefined") return html;
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.setConfig(PURIFY);
  }
  return purifier.sanitize(html);
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
  return [c.plain ? 1 : 0, c.cwd ?? "", c.board ? `${c.board.chatId}:${c.board.titles.size}` : "", c.mentions ? c.mentions.size : "", c.jobs ? namesKey(c.jobs) : ""].join("|");
}

/** A link a post previews as a card under its text: a wiki page, or a web page as Slack unfurls it. */
export type PreviewLink = { kind: "wiki"; path: string } | { kind: "web"; url: string };

/**
 * A web link Slack would unfurl and the text draws as a plain link: not a GitHub card, an image, a loopback address or a link into this
 * app, which the text already draws as a card, the image or a pill.
 */
function unfurlable(href: string): boolean {
  if (!/^https?:\/\//i.test(href) || GITHUB.test(href) || IMAGE_FILE.test(href.replace(/[?#].*$/, ""))) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (LOOPBACK_HOST.test(url.hostname) || url.port === "5184") return false;
  return !(typeof location !== "undefined" && url.origin === location.origin);
}

const previewCache = new Map<string, PreviewLink[]>();
/**
 * The links a text previews, in order and once each. A wiki page it links (`[label](wiki:<path>)`, `wiki:<path>`, `[[path]]`, a wiki URL
 * or a content path) gets a card, as legacy/prime/user-history's WikiEmbeds does; an image is not a page. Every other web link gets one,
 * as Slack unfurls every link in a message by default (docs.slack.dev/messaging/unfurling-links-in-messages). A link in code gets none.
 */
export function previewLinks(text: string): PreviewLink[] {
  if (!/wiki|\[\[|content\/|https?:\/\//.test(text)) return [];
  const hit = previewCache.get(text);
  if (hit) return hit;
  const links: PreviewLink[] = [];
  const wiki = (target: unknown) => {
    const path = typeof target === "string" && target.startsWith("wiki:") ? target.slice(5) : null;
    if (path && !IMAGE_FILE.test(path) && !links.some((l) => l.kind === "wiki" && l.path === path)) links.push({ kind: "wiki", path });
  };
  const web = (href: string) => {
    const url = href.replace(/#.*$/, "");
    if (unfurlable(url) && !links.some((l) => l.kind === "web" && l.url === url)) links.push({ kind: "web", url });
  };
  marked.walkTokens(marked.lexer(text), (token) => {
    const t = token as Tokens.Generic;
    if (t.type === "link") {
      const target = artifactTarget(String(t.href));
      if (target) wiki(target);
      else web(String(t.href));
    } else if (t.type === "wikiLink") wiki(t.target ?? `wiki:${String(t.path)}`);
    else if (t.type === "spacedLink" || t.type === "filePath") wiki(t.target);
    else if (t.type === "codespan") wiki(bareTarget(String(t.text)));
  });
  previewCache.set(text, links);
  if (previewCache.size > 3000) previewCache.delete(previewCache.keys().next().value!);
  return links;
}

/** Block markdown to sanitized HTML. */
export function renderMarkdown(text: string, context: MarkdownContext = {}): string {
  return cached(`b${contextKey(context)}\0${text}`, () => {
    ctx = context;
    try {
      return sanitize(marked.parse(text, { async: false, breaks: !!context.plain }));
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

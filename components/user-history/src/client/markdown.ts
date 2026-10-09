import { Marked, type Token, type TokenizerAndRendererExtension } from "marked";
import { normalizeArtifactTarget, WIKI_CONTENT_HOME } from "../shared/artifact-link.ts";
import { idClass, type MentionIndex } from "./board.ts";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Fenced block languages drawn in the sandboxed `render` frame. */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);
/** The thread folder, for image paths relative to it. Set around each synchronous parse. */
let renderCwd = "";
/** The chat's board ids and job names, for mention chips. Set around each synchronous parse; null renders every id and name as plain text. */
let renderIndex: MentionIndex | null = null;

/**
 * A board id written as a whole word (`p7`, `s3`) that exists on the chat's board becomes a chip: the item's dot color and id, its short title
 * on hover; the view's click handler opens the plan view on it. An id inside a code span, a code block or a link, or one the board does not
 * have, stays text. The tokenizer runs before marked's own at every position, so a code span or a URL consumes its ids whole; the lexer's
 * `inLink` covers link text; the token before the id must not end in a word character, so `xp7` is never a chip.
 */
const MENTION = /^[ps]\d+\b/;
const MENTION_START = /(^|[^\w])[ps]\d+\b/;
const mentions: TokenizerAndRendererExtension = {
  name: "mention",
  level: "inline",
  start(src) { const match = MENTION_START.exec(src); return match ? match.index + match[1]!.length : undefined; },
  tokenizer(src, tokens) {
    if (!renderIndex || this.lexer.state.inLink) return undefined;
    const match = MENTION.exec(src);
    if (!match || !renderIndex.titles.has(match[0]) || /\w$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    return { type: "mention", raw: match[0], id: match[0] };
  },
  renderer(token) {
    const id = String(token.id);
    const title = renderIndex?.titles.get(id) ?? id;
    return `<button type="button" class="mention-chip ${renderIndex ? idClass(renderIndex.chatId, id) : ""}" data-mention="${escapeHtml(id)}" title="${escapeHtml(title)}"><span class="dot" aria-hidden="true"></span>${escapeHtml(id)}</button>`;
  },
};

/**
 * A job of the chat named as a whole word becomes a chip with a bolt: hover previews its latest report, a click opens the report in the
 * reader. The same rules as board ids: not inside a code block, a link or a word (a hyphenated word counts as one word, so the job `w20`
 * is not a chip inside `w20-probe`). The longest name wins where one job's name starts another's. One exception to the code rule: a code
 * span that holds exactly a job name is a chip too, because the chats write job names in backticks (every mention in the VP chat did).
 */
const BOLT = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></svg>';
const previewAttributes = (job: string): string => renderIndex ? ` data-preview-chat="${escapeHtml(renderIndex.chatId)}" data-preview-job="${escapeHtml(job)}"` : "";
const jobChip = (name: string): string => `<button type="button" class="mention-chip job-chip" data-job="${escapeHtml(name)}"${previewAttributes(name)}>${BOLT}${escapeHtml(name)}</button>`;
const jobMentions: TokenizerAndRendererExtension = {
  name: "jobMention",
  level: "inline",
  start(src) { const match = renderIndex?.jobs?.start.exec(src); return match ? match.index + match[1]!.length : undefined; },
  tokenizer(src, tokens) {
    if (!renderIndex?.jobs || this.lexer.state.inLink) return undefined;
    const match = renderIndex.jobs.at.exec(src);
    const before = tokens.at(-1)?.raw ?? "";
    // A name inside quotes is the chat quoting it ("realtime layer"), not pointing at the job: it stays text.
    if (!match) return undefined;
    const after = src.slice(match[0].length);
    const quoted = /["\u201c]$/.test(before) || (/['\u2018]$/.test(before) && /^['\u2019]/.test(after));
    if (/[\w-]$/.test(before) || quoted) return undefined;
    return { type: "jobMention", raw: match[0], name: match[0] };
  },
  renderer(token) { return jobChip(String(token.name)); },
};
/** A code span that is one job name and nothing else (the chat writes `slack-bots-build`) is the same chip; any other code span stays code. */
const isJobName = (text: string): boolean => renderIndex?.jobs?.at.exec(text)?.[0] === text;

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
/**
 * An image file a link target names (`file:/x.png`, `wiki:sessions/.../x.png`, a bare path to one) shows as the image, not a link to a page the
 * reader cannot show: a small inline thumbnail in the text flow that opens full size on click (10-09, "image bugging?").
 */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
function targetImage(target: string): string | null {
  if (!IMAGE_FILE.test(target)) return null;
  if (target.startsWith("file:")) return imageSource(target.slice(5), renderCwd);
  if (target.startsWith("wiki:")) return imageSource(WIKI_CONTENT_HOME + "/" + target.slice(5), "");
  return null;
}
const thumb = (src: string, alt: string, source: string): string =>
  `<img class="reply-image thumb" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="${escapeHtml(source)}" loading="lazy" data-source="${escapeHtml(source)}">`;
const fileName = (path: string): string => path.split("/").at(-1) || path;
const artifactButton = (target: string, inner: string, tip: string): string =>
  // An <a> without href, not a <button>: a button lays out as an inline block, so a long label broke out of the sentence as its own centered
  // block (10-09). The view's click handler opens it; Enter on a focused one clicks it (App's key handler).
  `<a class="artifact-link" role="link" tabindex="0" data-target="${escapeHtml(target)}"${target.startsWith("job:") ? previewAttributes(target.slice(4)) : ""} title="${escapeHtml(tip)}">${inner}</a>`;

/**
 * A link target the chat wrote bare in prose (`wiki:<path>`, `file:/path`, `job:<name>`, `thread:<id>`, an absolute path, or a path through
 * `apps/llm-wiki/content/`) is the same button a markdown link to it gets; a bare URL is marked's own autolink. A target inside a word,
 * a link or a code block stays text, and trailing sentence punctuation stays outside the link. A code span that holds exactly one target
 * is a link too, like a job name in backticks.
 */
const BARE_TARGET = /^(?:wiki:|file:|job:|thread:|\/(?=[A-Za-z][^\s/]*\/\S)|apps\/llm-wiki\/content\/)[^\s<>()[\]`"'*]+/;
const BARE_TARGET_START = /(^|[^\w~./:-])(?:wiki:|file:|job:|thread:|\/[A-Za-z]|apps\/llm-wiki\/content\/)/;
const WIKI_CONTENT = /^(?:\/.*?\/)?apps\/llm-wiki\/content\//;
function bareTarget(text: string): { raw: string; target: string } | null {
  const match = BARE_TARGET.exec(text);
  if (!match) return null;
  const raw = match[0].replace(/[.,;:!?]+$/, "");
  const content = WIKI_CONTENT.exec(raw);
  const target = normalizeArtifactTarget(content ? "wiki:" + raw.slice(content[0].length) : raw);
  return target ? { raw, target } : null;
}
const bareTargets: TokenizerAndRendererExtension = {
  name: "bareTarget",
  level: "inline",
  start(src) { const match = BARE_TARGET_START.exec(src); return match ? match.index + match[1]!.length : undefined; },
  tokenizer(src, tokens) {
    if (this.lexer.state.inLink || /[\w~./:-]$/.test(tokens.at(-1)?.raw ?? "")) return undefined;
    const found = bareTarget(src);
    return found ? { type: "bareTarget", raw: found.raw, target: found.target } : undefined;
  },
  renderer(token) {
    const target = String(token.target);
    const image = targetImage(target);
    return image ? thumb(image, fileName(String(token.raw)), String(token.raw)) : artifactButton(target, escapeHtml(token.raw), target);
  },
};

/**
 * `[label](job:name with spaces)`: CommonMark ends a link destination at a space, so a job link the brief asks for (job names are plain words)
 * fell apart into text and a `job:<first word>` link. A link whose target is an artifact form and holds spaces is read whole here.
 */
const SPACED_LINK = /^\[([^\]\n]{1,300})\]\(((?:job|thread|wiki|file):[^()\n]{1,500}?)\)/;
const spacedLinks: TokenizerAndRendererExtension = {
  name: "spacedLink",
  level: "inline",
  start(src) { const index = src.search(/\[[^\]\n]{1,300}\]\((?:job|thread|wiki|file):[^()\n]* /); return index >= 0 ? index : undefined; },
  tokenizer(src) {
    const match = SPACED_LINK.exec(src);
    if (!match || !/\s/.test(match[2]!)) return undefined;
    const target = normalizeArtifactTarget(match[2]!);
    if (!target) return undefined;
    return { type: "spacedLink", raw: match[0], target, tokens: this.lexer.inlineTokens(match[1]!) };
  },
  renderer(token) { return artifactButton(String(token.target), this.parser.parseInline(token.tokens ?? []), String(token.target)); },
};

const marked = new Marked({
  gfm: true,
  extensions: [spacedLinks, mentions, jobMentions, bareTargets],
  async: false,
  // Raw HTML is escaped, so a literal <table> in the output always came from the table renderer.
  hooks: { postprocess: html => html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>") },
  renderer: {
    html({ text }) { return escapeHtml(text); },
    codespan({ text }) {
      if (isJobName(text)) return jobChip(text);
      const found = bareTarget(text);
      return found?.raw === text ? artifactButton(found.target, `<code>${escapeHtml(text)}</code>`, found.target) : false;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const tip = escapeHtml(title ? `${title} (${href})` : href);
      const target = artifactTarget(href);
      const image = target ? targetImage(target) : null;
      if (image) return thumb(image, tokens.map(token => token.raw).join("") || fileName(href), href);
      if (target) return artifactButton(target, text, title ? `${title} (${href})` : href);
      if (WEB_LINK.test(href)) return `<a href="${escapeHtml(href)}" title="${tip}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return `<span class="path-link" title="${tip}">${text}</span>`;
    },
    image({ href, title, text }) {
      const named = /^(?:wiki|file):/.test(href) ? normalizeArtifactTarget(href) : null;
      const src = named ? targetImage(named) : imageSource(href, renderCwd);
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

/** `index` turns the chat's board ids and job names in the text into mention chips; a reply outside a chat passes none. */
export function renderMarkdown(text: string, cwd = "", index: MentionIndex | null = null): string {
  const key = cwd + "\0" + (index?.key ?? "") + "\0" + text;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  renderCwd = cwd;
  renderIndex = index;
  let html: string;
  try { html = marked.parse(text, { async: false }); } finally { renderCwd = ""; renderIndex = null; }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

/** The owner's own bubble: links, inline code, bold, mention chips and line breaks only; no lists, headings or blocks. */
export function renderInline(text: string, index: MentionIndex | null = null): string {
  const key = "inline\0" + (index?.key ?? "") + "\0" + text;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  renderIndex = index;
  let html: string;
  try { html = marked.parseInline(text.replace(/\r\n?/g, "\n"), { async: false, breaks: true }); } finally { renderIndex = null; }
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

/** A report cut for the preview card: its first `limit` blocks (a paragraph, a list, a table, a fence each count one), and whether more followed. */
export function reportExcerpt(text: string, limit = 12): { text: string; cut: boolean } {
  const blocks = marked.lexer(text).filter(token => token.type !== "space");
  return { text: blocks.slice(0, limit).map(token => token.raw.trimEnd()).join("\n\n"), cut: blocks.length > limit };
}

/** The artifact target of a clicked `.artifact-link` in rendered markdown, or null. */
export function artifactFromClick(event: MouseEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>(".artifact-link");
  if (!button?.dataset.target) return null;
  event.preventDefault();
  return button.dataset.target;
}

/** The board id of a clicked `.mention-chip` in rendered text, or null. */
export function mentionFromClick(event: MouseEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const chip = target.closest<HTMLElement>("button.mention-chip");
  if (!chip?.dataset.mention) return null;
  event.preventDefault();
  return chip.dataset.mention;
}

/** The job name of a clicked `.job-chip` in rendered text, or null. */
export function jobFromClick(event: MouseEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const chip = target.closest<HTMLElement>("button.job-chip");
  if (!chip?.dataset.job) return null;
  event.preventDefault();
  return chip.dataset.job;
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

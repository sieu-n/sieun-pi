/**
 * The agent form of a wiki page. Pages stay HTML on disk with a `<!--wiki {json}-->` frontmatter comment; an agent reads them as markdown
 * made with Turndown, under a YAML header whose values are JSON, and may write markdown back, which `marked` turns into HTML.
 */
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type Meta = Record<string, unknown>;

const FRONTMATTER = /^\s*<!--wiki\s*([\s\S]*?)\s*-->\s*/;

/** A stored page split into its frontmatter and its HTML body. A page without the comment, or with one that is not JSON, has none. */
export function splitPage(content: string): { meta: Meta | null; html: string } {
  const match = FRONTMATTER.exec(content);
  if (!match) return { meta: null, html: content };
  try {
    return { meta: JSON.parse(match[1]!) as Meta, html: content.slice(match[0].length) };
  } catch {
    return { meta: null, html: content.slice(match[0].length) };
  }
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
turndown.use(gfm);
// A mermaid diagram is its source, not escaped prose.
turndown.addRule("mermaid", {
  filter: node => node.nodeName === "PRE" && /\bmermaid\b/.test(node.getAttribute("class") ?? ""),
  replacement: (_content, node) => `\n\n\`\`\`mermaid\n${(node.textContent ?? "").trim()}\n\`\`\`\n\n`,
});
// One space after a list marker, so a numbered line reads `1. text` and not Turndown's `1.  text`.
turndown.addRule("listItem", {
  filter: "li",
  replacement: (content, node) => {
    const parent = node.parentNode as HTMLElement | null;
    let marker = "- ";
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? 1);
      marker = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
    }
    const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${" ".repeat(marker.length)}`);
    return marker + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
  },
});

/** The YAML header: one `key: <json>` line per field, which YAML reads as flow values and `parseHeader` reads back exactly. */
function header(meta: Meta): string {
  const lines = Object.entries(meta).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/** A page as markdown: its header carries `path` and `version` first, so an edited copy can go back with `version` as its base. */
export function toMarkdown(content: string, extra: Meta): string {
  const { meta, html } = splitPage(content);
  return header({ ...extra, ...meta }) + turndown.turndown(html).trim() + "\n";
}

/** The header of a markdown body and the rest. A line whose value is not JSON keeps its text as a string. */
export function parseHeader(markdown: string): { meta: Meta; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const meta: Meta = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const raw = line.slice(at + 1).trim();
    try {
      meta[line.slice(0, at).trim()] = JSON.parse(raw);
    } catch {
      meta[line.slice(0, at).trim()] = raw;
    }
  }
  return { meta, body: markdown.slice(match[0].length) };
}

/** A markdown write as the page the engine stores: the header becomes the frontmatter, less `path` and `version`, which `version` answers as the base. */
export function fromMarkdown(markdown: string): { content: string; baseVersion?: number } {
  const { meta, body } = parseHeader(markdown);
  const { path: _path, version, ...rest } = meta;
  const html = (marked.parse(body, { async: false }) as string).trim();
  const content = Object.keys(rest).length ? `<!--wiki ${JSON.stringify(rest)} -->\n${html}\n` : `${html}\n`;
  return { content, ...(typeof version === "number" ? { baseVersion: version } : {}) };
}

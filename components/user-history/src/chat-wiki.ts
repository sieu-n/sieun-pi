import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WIKI_ORIGIN } from "./shared/artifact-link.ts";
import { LocalFileError, readLocalText } from "./chat-render.ts";

/**
 * What the reader shows for a wiki page: the page's own HTML (a `.html` page, drawn in the sandboxed render frame) or its markdown
 * (a `.md` page, rendered as the chat renders a reply), its title, the page URL on the wiki, and the folder it lives in on this Mac
 * (relative images in the page resolve against it).
 */
export type WikiPageView = { path: string; title: string; url: string; dir: string } & ({ kind: "html"; html: string } | { kind: "markdown"; text: string });

export const WIKI_TIMEOUT_MS = 5000;
/** The llm-wiki checkout the dev server serves; the page's file is read from here when the dev server is down. */
export const WIKI_CONTENT_DIR = join(homedir(), "Documents/Github/auto-sns-agent/apps/llm-wiki/content");
const MAX_PATH = 2048;

export function wikiPagePath(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.length > MAX_PATH || clean.includes("\0") || /\s/.test(clean) || clean.split("/").some(part => part === ".." || part === ".")) {
    throw new LocalFileError(400, "Give a wiki page path.");
  }
  return clean;
}

const FRONTMATTER = /^\s*<!--wiki\s*([\s\S]*?)-->\s*/;
/** The `<!--wiki {...}-->` frontmatter is the wiki's metadata; a markdown renderer would show it as text. */
const stripFrontmatter = (content: string): string => content.replace(FRONTMATTER, "");
/** The page's title as the wiki would show it: the `<!--wiki {...}-->` frontmatter's `title`, the first `<h1>` or `# ` line, or the file name. */
export function wikiTitle(content: string, path: string): string {
  const front = FRONTMATTER.exec(content)?.[1];
  if (front) {
    try { const title = (JSON.parse(front) as { title?: unknown }).title; if (typeof title === "string" && title.trim()) return title.trim(); } catch { /* not JSON, fall through */ }
  }
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1]?.replace(/<[^>]+>/g, "") ?? /^#\s+(.+)$/m.exec(content)?.[1];
  return heading?.trim() || path.split("/").at(-1) || path;
}

/**
 * Reads a page through the dev server's own API (`api/agent/page`), so a phone on the tailnet, which cannot reach localhost:5176, still
 * gets the page. A refusal by the wiki (404, the read cap) is passed on with its text. No answer in 5 s, or a refused connection, falls
 * back to the page's file under the content folder; a page neither has is 502 with the wiki's silence named.
 */
export async function readWikiPage(path: string, fetchImpl: typeof fetch = fetch, origin = WIKI_ORIGIN, contentDir = WIKI_CONTENT_DIR): Promise<WikiPageView> {
  const clean = wikiPagePath(path);
  const url = origin + "/page/" + clean;
  const dir = dirname(join(contentDir, clean));
  let response: Response;
  try { response = await fetchImpl(origin + "/api/agent/page?path=" + encodeURIComponent(clean), { signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) }); }
  catch { return readWikiFile(clean, url, dir, contentDir, "The wiki at " + origin + " did not answer."); }
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (!response.ok) throw new LocalFileError(response.status === 404 ? 404 : 502, typeof record.error === "string" ? record.error : "The wiki answered " + response.status + ".");
  if (typeof record.content !== "string") throw new LocalFileError(502, "The wiki sent no page text.");
  const title = typeof record.title === "string" && record.title ? record.title : wikiTitle(record.content, clean);
  const head = { path: clean, title, url, dir };
  // The file's own extension decides the format. The API's `kind` is the page's frontmatter kind (report, decision, session-artifact, ...);
  // it only read "html" for older pages, so every page with another frontmatter kind was refused (10-09: chat links explained, kind "report").
  if (/\.html?$/i.test(clean)) return { ...head, kind: "html", html: record.content };
  if (/\.md$/i.test(clean)) return { ...head, kind: "markdown", text: stripFrontmatter(record.content) };
  throw new LocalFileError(415, "Only .html and .md wiki pages show here.");
}

async function readWikiFile(clean: string, url: string, dir: string, contentDir: string, silence: string): Promise<WikiPageView> {
  let file: Awaited<ReturnType<typeof readLocalText>>;
  try { file = await readLocalText(join(contentDir, clean), [contentDir]); }
  catch (error) {
    if (error instanceof LocalFileError && error.status === 404) throw new LocalFileError(502, silence + " Its file is not in the wiki folder either.");
    throw error;
  }
  const head = { path: clean, title: wikiTitle(file.text, clean), url, dir };
  if (file.kind === "markdown") return { ...head, kind: "markdown", text: stripFrontmatter(file.text) };
  if (/\.html?$/i.test(clean)) return { ...head, kind: "html", html: file.text };
  throw new LocalFileError(415, "Only .html and .md wiki pages show here.");
}

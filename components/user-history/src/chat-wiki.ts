import { WIKI_ORIGIN } from "./shared/artifact-link.ts";
import { LocalFileError } from "./chat-render.ts";

/** What the reader shows for a `wiki:` link: the page's plain text from the llm-wiki dev server, its title and headings, and the page URL. */
export interface WikiPageView { path: string; title: string; url: string; text: string; headings: string[] }

export const WIKI_TIMEOUT_MS = 5000;
const MAX_PATH = 2048;

/**
 * Reads a page through the dev server's own API (`api/agent/page?render=text`), so a phone on the tailnet, which cannot reach
 * localhost:5176, still gets the page. A refusal by the wiki (404, the read cap) is passed on with its text; no answer in 5 s is 502.
 */
export async function readWikiPage(path: string, fetchImpl: typeof fetch = fetch, origin = WIKI_ORIGIN): Promise<WikiPageView> {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.length > MAX_PATH || clean.includes("\0") || /\s/.test(clean) || clean.split("/").some(part => part === ".." || part === ".")) {
    throw new LocalFileError(400, "Give a wiki page path.");
  }
  const url = origin + "/page/" + clean;
  let response: Response;
  try { response = await fetchImpl(origin + "/api/agent/page?path=" + encodeURIComponent(clean) + "&render=text", { signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) }); }
  catch { throw new LocalFileError(502, "The wiki at " + origin + " did not answer."); }
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (!response.ok) throw new LocalFileError(response.status === 404 ? 404 : 502, typeof record.error === "string" ? record.error : "The wiki answered " + response.status + ".");
  if (typeof record.content !== "string") throw new LocalFileError(502, "The wiki sent no page text.");
  const headings = Array.isArray(record.headings) ? record.headings.filter((heading): heading is string => typeof heading === "string") : [];
  return { path: clean, title: typeof record.title === "string" && record.title ? record.title : clean.split("/").at(-1) ?? clean, url, text: record.content, headings };
}

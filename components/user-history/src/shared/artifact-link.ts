/**
 * Artifact link targets, shared by the board reducer (it stores the normalized form) and the page (it opens them). Pure and browser-safe.
 *
 *   job:<name>                     a job's drawer in this chat
 *   thread:<sessionId>[@<ms>]      a thread, or one message in it (the message's `timestamp`)
 *   wiki:<path>                    an llm-wiki page, http://localhost:5176/page/<path>
 *   file:<absolute path>           a text file on this Mac, read through `GET api/local-file`
 *   http(s)://...                  a web page
 */
export type ArtifactTarget =
  | { kind: "job"; name: string }
  | { kind: "thread"; sessionId: string; at?: number }
  | { kind: "wiki"; path: string }
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

export const WIKI_ORIGIN = "http://localhost:5176";
/** The llm-wiki content folder under the home folder: the server reads pages from it, and the page loads a wiki image from it through api/local-image. */
export const WIKI_CONTENT_HOME = "~/Documents/Github/auto-sns-agent/apps/llm-wiki/content";
const THREAD = /^([a-zA-Z0-9_-]{1,128})(?:@(\d{1,16}))?$/;
const JOB = /^[^\s/]{1,128}$/;
/** Session ids are UUIDs; a URL whose hash is one (or the chat's port) is a pasted chat link. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_PORT = "5182";
const MAX_TARGET = 2048;

function thread(text: string): ArtifactTarget | null {
  const match = THREAD.exec(text);
  if (!match) return null;
  if (match[2] === undefined) return { kind: "thread", sessionId: match[1]! };
  const at = Number(match[2]);
  return Number.isSafeInteger(at) ? { kind: "thread", sessionId: match[1]!, at } : null;
}
function wikiPath(path: string): string | null {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.includes("\0") || /\s/.test(clean) || clean.split("/").some(part => part === ".." || part === ".")) return null;
  return clean;
}
function decode(text: string): string { try { return decodeURIComponent(text); } catch { return ""; } }
function webUrl(text: string): URL | null {
  try { const url = new URL(text); return url.protocol === "https:" || url.protocol === "http:" ? url : null; } catch { return null; }
}

export function parseArtifactTarget(target: string): ArtifactTarget | null {
  if (typeof target !== "string" || !target || target.length > MAX_TARGET || target !== target.trim()) return null;
  if (target.startsWith("job:")) { const name = target.slice(4); return JOB.test(name) ? { kind: "job", name } : null; }
  if (target.startsWith("thread:")) return thread(target.slice(7));
  if (target.startsWith("wiki:")) { const path = target.slice(5); return path && wikiPath(path) === path ? { kind: "wiki", path } : null; }
  if (target.startsWith("file:")) { const path = target.slice(5); return path.startsWith("/") && !path.includes("\0") ? { kind: "file", path } : null; }
  return webUrl(target) ? { kind: "url", url: target } : null;
}

/**
 * The stored form of what the owner or the agent typed: a target as above, a pasted chat URL (`.../#<sessionId>@<ms>`), a pasted wiki URL
 * (`http://localhost:5176/page/<path>`), or a bare absolute path. Null when it is none of these.
 */
export function normalizeArtifactTarget(input: string): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (text.startsWith("/")) return parseArtifactTarget("file:" + text) ? "file:" + text : null;
  const url = webUrl(text);
  if (url) {
    const hash = thread(decode(url.hash.slice(1)));
    if (hash?.kind === "thread" && (UUID.test(hash.sessionId) || url.port === CHAT_PORT)) return "thread:" + hash.sessionId + (hash.at !== undefined ? "@" + hash.at : "");
    if (url.origin === WIKI_ORIGIN || url.origin === "http://127.0.0.1:5176") {
      const page = /^\/page\/(.+)$/.exec(url.pathname);
      const path = page ? wikiPath(decode(page[1]!)) : null;
      if (path) return "wiki:" + path;
    }
  }
  return parseArtifactTarget(text) ? text : null;
}


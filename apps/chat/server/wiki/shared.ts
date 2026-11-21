/**
 * The posts that share a wiki page: GET /api/pages/shared?path=<path> answers the wiki pane's "Shared in" card, as a Slack canvas lists the
 * conversations it was shared in. A post shares a page when its text names the page's path as a link (`wiki:<path>`, `[[<path>]]`, a
 * `/wiki/<path>` URL or a bare path); a page that is a folder's `index.html` is also shared by a link to the folder. Test rooms stay out.
 */
import type { WikiShare } from "../../web/src/lib/api/types.ts";
import type { RoomPost } from "../agent-store.ts";

const LIMIT = 50;
const SNIPPET = 140;

/** What the posts come from: each channel, Solo room and agent DM, and its posts. */
export interface ShareSource { rooms(): string[]; postsOf(room: string): RoomPost[]; isTest(room: string): boolean }

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms of `path` a link can take: the path itself, and for a folder's index page the folder with and without its slash. */
export function pathForms(path: string): string[] {
  const clean = path.replace(/^\/+/, "");
  const folder = /^(.*)\/index\.html?$/i.exec(clean)?.[1];
  return folder ? [clean, `${folder}/`, folder] : [clean];
}

/** One pattern for every form, bounded so `a/b.html` does not match `a/b.html.bak` or `x/a/b.html`. */
export function sharePattern(path: string): RegExp {
  const forms = pathForms(path).flatMap(form => [form, form.split("/").map(encodeURIComponent).join("/")]);
  const alternatives = [...new Set(forms)].sort((a, b) => b.length - a.length).map(escape).join("|");
  return new RegExp(`(?:wiki:|\\[\\[|/wiki/|/page/|^|[\\s(\`'"<])(?:${alternatives})(?![\\w./-])`, "m");
}

const snippetOf = (text: string): string => {
  const flat = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[#>\s]+/gm, "").replace(/[*`]+/g, "").replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1)}…` : flat;
};

export function sharedIn(source: ShareSource, path: string): WikiShare[] {
  if (!path.trim()) return [];
  const pattern = sharePattern(path.trim());
  const found: WikiShare[] = [];
  for (const room of source.rooms()) {
    if (source.isTest(room)) continue;
    for (const post of source.postsOf(room)) {
      if (!pattern.test(post.text)) continue;
      found.push({ room, post: post.id, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}), author: post.author, at: post.at, snippet: snippetOf(post.text) });
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, LIMIT);
}

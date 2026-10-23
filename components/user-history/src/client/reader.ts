import { parseArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";
import type { WikiPage } from "./api.ts";

/**
 * What the reader modal shows. Every artifact link opens here, except a web URL (a new tab) and a bare `thread:<id>` (the thread itself).
 * `thread` is the thread the link was opened from: a job's reports are the agent messages in that thread's feed. A fold view has no
 * link form; the fold row in the chat opens it.
 */
export type ReaderView =
  | { kind: "job"; thread: string; name: string }
  | { kind: "file"; path: string }
  | { kind: "wiki"; path: string }
  | { kind: "message"; thread: string; at: number }
  /** A fold of background lines in a chat's feed, keyed by the time of its first line. */
  | { kind: "fold"; thread: string; at: number };

export type ReaderAction = { open: "tab"; url: string } | { open: "thread"; sessionId: string } | { open: "reader"; view: ReaderView };

export function readerAction(target: ArtifactTarget, thread: string): ReaderAction {
  switch (target.kind) {
    case "url": return { open: "tab", url: target.url };
    case "thread": return target.at === undefined ? { open: "thread", sessionId: target.sessionId } : { open: "reader", view: { kind: "message", thread: target.sessionId, at: target.at } };
    case "job": return { open: "reader", view: { kind: "job", thread, name: target.name } };
    case "wiki": return { open: "reader", view: { kind: "wiki", path: target.path } };
    case "file": return { open: "reader", view: { kind: "file", path: target.path } };
  }
}

/** The wiki's origin, http://<address>:<port> of the wiki host in hosts.json, which the service writes on the page body as data-wiki. */
const wikiOrigin = (): string => (typeof document === "undefined" ? "" : document.body.dataset.wiki ?? "");
export const wikiUrl = (path: string): string => wikiOrigin() + "/page/" + path;

/** One line of a unified diff: the file headers, a hunk header, an added or removed line, git's metadata, or context. */
export type DiffLineKind = "file" | "hunk" | "add" | "del" | "meta" | "context";
const DIFF_META = /^(diff |index |new file |deleted file |old mode |new mode |similarity |rename |copy |Binary files |\\ No newline)/;
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (DIFF_META.test(line)) return "meta";
  return "context";
}
export const diffLines = (text: string): { kind: DiffLineKind; text: string }[] =>
  text.replace(/\n$/, "").split("\n").map(line => ({ kind: diffLineKind(line), text: line }));

/**
 * The wiki page a job's report links, as the report's reader shows it under the text: the first `.html` or `.md` page named as a wiki
 * URL (`http://<host>:5176/page/<path>` or `/raw/<path>`), a `wiki:` link in any form `wikiLinkPath` reads, or a path through
 * `apps/llm-wiki/content/<path>` (absolute or from the repo root), with any `#hash` dropped. Null when the report names none.
 */
const WIKI_LINK = /(?:https?:\/\/[^\s\/`"'<>()]+:5176\/(?:page|raw)\/|wiki:|(?:^|[\s(\[<`"'])(?:\/[^\s`"'<>()]*?\/)?apps\/llm-wiki\/content\/)([^\s`"'<>()\[\]]+?\.(?:html|md))(?=[\s`"'<>()\[\].,;:#?]|$)/gi;
export const reportWikiPage = (text: string): string | null => wikiPages(text)[0] ?? null;

/** Every wiki page the text links, in the same forms as `reportWikiPage`, each once. */
export function wikiPages(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(WIKI_LINK)) {
    const target = parseArtifactTarget("wiki:" + match[1]!);
    if (target?.kind === "wiki") paths.add(target.path);
  }
  return [...paths];
}

/** A page's one-line summary for its card: its `<wiki-tldr>`, its description, or its first paragraph; empty when it has none. */
export function pageSummary(page: WikiPage): string {
  let text = "";
  if (page.kind === "html") {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    text = doc.querySelector("wiki-tldr")?.textContent ?? doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? doc.querySelector("main p, article p, p")?.textContent ?? "";
  } else {
    text = page.text.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\n\s*\n/).map(block => block.trim()).find(block => block && !/^(#|```|<|\||-{3,}|!\[)/.test(block)) ?? "";
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "");
  }
  return text.replace(/\s+/g, " ").trim();
}

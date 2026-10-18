import { parseArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";

/**
 * What the reader modal shows. Every artifact link opens here, except a web URL (a new tab) and a bare `thread:<id>` (the thread itself).
 * `thread` is the thread the link was opened from: a job's reports are the agent messages in that thread's feed. An updates view has no
 * link form; the folded line in the chat opens it.
 */
export type ReaderView =
  | { kind: "job"; thread: string; name: string }
  | { kind: "file"; path: string }
  | { kind: "wiki"; path: string }
  | { kind: "message"; thread: string; at: number }
  /** A folded run of quiet lines in a chat's feed, keyed by the time of its first line. */
  | { kind: "updates"; thread: string; at: number };

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
 * URL (`http://<host>:5176/page/<path>`), a `wiki:<path>` target, or a path through `apps/llm-wiki/content/<path>` (absolute or
 * from the repo root). Null when the report names none.
 */
const WIKI_LINK = /(?:https?:\/\/[^\s\/`"'<>()]+:5176\/page\/|wiki:|(?:^|[\s(\[<`"'])(?:\/[^\s`"'<>()]*?\/)?apps\/llm-wiki\/content\/)([^\s`"'<>()\[\]]+?\.(?:html|md))(?=[\s`"'<>()\[\].,;:]|$)/gi;
export function reportWikiPage(text: string): string | null {
  for (const match of text.matchAll(WIKI_LINK)) {
    const target = parseArtifactTarget("wiki:" + match[1]!);
    if (target?.kind === "wiki") return target.path;
  }
  return null;
}

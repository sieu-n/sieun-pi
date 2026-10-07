import { WIKI_ORIGIN, type ArtifactTarget } from "../shared/artifact-link.ts";

/**
 * What the reader modal shows. Every artifact link opens here, except a web URL (a new tab) and a bare `thread:<id>` (the thread itself).
 * `thread` is the thread the link was opened from: a job's reports are the agent messages in that thread's feed.
 */
export type ReaderView =
  | { kind: "job"; thread: string; name: string }
  | { kind: "file"; path: string }
  | { kind: "wiki"; path: string }
  | { kind: "message"; thread: string; at: number };

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

export const wikiUrl = (path: string): string => WIKI_ORIGIN + "/page/" + path;

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

/** A wiki page's plain text as paragraphs; a paragraph that is one of the page's headings reads as a heading. */
export type WikiBlock = { kind: "heading" | "paragraph"; text: string };
export function wikiBlocks(text: string, headings: readonly string[]): WikiBlock[] {
  const known = new Set(headings.map(heading => heading.trim()));
  const blocks: WikiBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") }); paragraph = []; };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (known.has(line)) { flush(); blocks.push({ kind: "heading", text: line }); continue; }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

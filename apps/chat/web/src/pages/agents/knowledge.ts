import type { AgentScript } from "$lib/api";
import { ageLabel } from "../../lib/ui/datetime.ts";
import { shortPath } from "./agents-model";

/** A short last-change line for a one-line row, such as "changed 3d ago" or "changed Nov 3"; the row's tooltip holds the full time. */
export function changedLabel(at: number, now = Date.now()): string {
  const age = ageLabel(at, now);
  return age === "now" ? "changed now" : /^\d+[mhd]$/.test(age) ? `changed ${age} ago` : `changed ${age}`;
}

/**
 * A path cut to fit one row: home-relative, and past `max` characters its middle folders give way to "…", so the folder and file at its end
 * stay readable. A Prime release's skill path runs about 150 characters, most of it the release folder's name.
 */
export function compactPath(path: string, max = 64): string {
  const short = shortPath(path);
  if (short.length <= max) return short;
  const parts = short.split("/");
  const fits = (head: string[], tail: string[]) => [...head, "…", ...tail].join("/").length <= max;
  let head = parts.slice(0, 1);
  let tail = parts.slice(-1);
  // The end first, folder by folder, then the start with what room is left.
  for (let i = parts.length - 2; i > head.length && fits(head, [parts[i]!, ...tail]); i--) tail = [parts[i]!, ...tail];
  for (let i = 1; i < parts.length - tail.length - 1 && fits([...head, parts[i]!], tail); i++) head = [...head, parts[i]!];
  return [...head, "…", ...tail].join("/");
}

/**
 * The instruction files in the order a prompt holds them: the config lists the nearest folder first and the global files last, and the
 * prompt puts the global ones first, then each folder down to the cwd, with AGENTS.md before CLAUDE.md inside a folder.
 */
export function loadOrder<T extends { path: string }>(files: readonly T[]): T[] {
  const folders: T[][] = [];
  for (const file of files) {
    const dir = file.path.slice(0, file.path.lastIndexOf("/"));
    const last = folders.at(-1);
    if (last && last[0]!.path.slice(0, last[0]!.path.lastIndexOf("/")) === dir) last.push(file);
    else folders.push([file]);
  }
  return folders.reverse().flat();
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Where a script comes from, as its row says it. */
export function scriptSource(from: AgentScript["from"]): string {
  switch (from.kind) {
    case "folder":
      return "Kept in its folder";
    case "brief":
      return "Named in its brief";
    case "duty":
      return `Duty ${from.duty}, ${from.name}, runs it as its precheck`;
    default: {
      const _exhaustive: never = from;
      return _exhaustive;
    }
  }
}

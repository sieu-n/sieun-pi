/** Pure helpers for the Skills section: the kind groups, the filter, and the words and tones of a row's flags and verdict. */
import type { SkillKind, SkillRow, SkillVerdict } from "$lib/api/shared/skills";

type Tone = "neutral" | "accent" | "danger" | "strong" | "outline" | "warning" | "success";

/** The groups in page order, each with the line under its title. */
export const KIND_GROUPS: readonly { kind: SkillKind | "other"; title: string; description: string; icon: string }[] = [
  { kind: "ours", title: "Ours", description: "Skills we wrote, in sieun-pi or a project repo.", icon: "star" },
  { kind: "fork", title: "Forks", description: "Copies of an upstream skill that we changed.", icon: "copy" },
  { kind: "upstream", title: "Upstream", description: "Skills as their vendor ships them, Prime's bundled ones included.", icon: "download" },
  { kind: "pointer", title: "Pointers", description: "Rows that only point at another skill.", icon: "arrow-right" },
  { kind: "rule", title: "Rules", description: "Rule files that push agents to a skill.", icon: "flag" },
  { kind: "harness", title: "Harness", description: "Continual harness entries that act as skills.", icon: "spark" },
  { kind: "other", title: "Other", description: "Rows whose kind the scanner did not name.", icon: "file" },
];

export type Filter = "all" | "flagged" | "act";

export const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "flagged", label: "Flagged" },
  { id: "act", label: "Merge or remove" },
];

export const isFlagged = (row: SkillRow): boolean => row.flags.length > 0 || row.duplicateOf.length > 0 || row.upstream?.status === "drift";
export const needsAction = (row: SkillRow): boolean => row.useful.verdict === "merge" || row.useful.verdict === "remove";

/** Whether a row passes the filter tab and the text in the search field, which matches its name, description, path, box and group. */
export function matches(row: SkillRow, filter: Filter, text: string): boolean {
  if (filter === "flagged" && !isFlagged(row)) return false;
  if (filter === "act" && !needsAction(row)) return false;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [row.name, row.description, row.path, row.box, row.group ?? ""].join(" ").toLowerCase();
  return words.every(word => hay.includes(word));
}

/** The groups that hold a row after the filter, each sorted by name, then box. */
export function grouped(rows: readonly SkillRow[], filter: Filter, text: string): { group: (typeof KIND_GROUPS)[number]; rows: SkillRow[] }[] {
  return KIND_GROUPS.map(group => ({
    group,
    rows: rows.filter(row => row.kind === group.kind && matches(row, filter, text)).sort((a, b) => a.name.localeCompare(b.name) || a.box.localeCompare(b.box)),
  })).filter(entry => entry.rows.length > 0);
}

const FLAG_TONES: Readonly<Record<string, Tone>> = { duplicate: "warning", drift: "warning", pointer: "outline", unrequested: "danger", unused: "neutral", broken: "danger" };

/** A row's flag badges: its scanner flags, plus duplicate and drift when the scanner set the fields and no flag says so. */
export function flagBadges(row: SkillRow): { label: string; tone: Tone; detail: string }[] {
  const badges = row.flags.map(flag => ({ label: flag.kind, tone: FLAG_TONES[flag.kind] ?? "neutral", detail: flag.detail }));
  const has = (kind: string) => badges.some(badge => badge.label === kind);
  if (row.duplicateOf.length && !has("duplicate")) badges.push({ label: "duplicate", tone: "warning", detail: `Same skill as ${row.duplicateOf.length === 1 ? "1 other row" : `${row.duplicateOf.length} other rows`}.` });
  if (row.upstream?.status === "drift" && !has("drift")) badges.push({ label: "drift", tone: "warning", detail: `Differs from ${row.upstream.url}.` });
  return badges;
}

export const VERDICT_TONE: Readonly<Record<SkillVerdict, Tone>> = { keep: "success", merge: "warning", remove: "danger" };

/** The second line of a row: its path, then who loads it and its last use. */
export function rowDetail(row: SkillRow, now: number): string {
  const loaders = row.loadedBy.agents.length ? `loaded by ${listOf(row.loadedBy.agents, 3)}` : row.loadedBy.how.length ? `loaded through ${row.loadedBy.how.join(", ")}` : "";
  const last = row.uses[0];
  const used = last ? `last used ${agoText(Date.parse(last.at), now)}${last.agent ? ` by ${last.agent}` : ""}` : row.uses30d === 0 ? "no use in 30 days" : "";
  return [shortPath(row.path), loaders, used].filter(Boolean).join(" · ");
}

export function listOf(names: readonly string[], max: number): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** A path with the home folder shown as ~. */
export const shortPath = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/)/, "~");

export function agoText(at: number, now: number): string {
  if (!Number.isFinite(at)) return "at an unknown time";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The frontmatter of a SKILL.md as its own text, and the body after it, so the popup shows the fields apart from the prose. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? { frontmatter: match[1]!, body: text.slice(match[0].length) } : { frontmatter: null, body: text };
}

import type {
  BoxName, CopyRole, SkillBoxState, SkillCopy, SkillEntry, SkillRuntime, SkillThresholds, SkillTreeNode, SkillVerdictRow, SkillsView,
} from "$lib/api/shared/skills";
import { COUNT_RULES } from "../../../../lib/api/shared/skills.ts";

export type Problem = keyof typeof COUNT_RULES;
export const PROBLEM_IDS = Object.keys(COUNT_RULES) as Problem[];

const RUNTIME_LABEL: Record<SkillRuntime, string> = { prime: "Prime", "pi-host": "pi-host", claude: "Claude Code", codex: "Codex", pi: "pi" };
export const runtimeLabel = (runtime: SkillRuntime): string => RUNTIME_LABEL[runtime];

export const boxLabel = (box: BoxName): string => (box === "mac" ? "Mac" : box);

/** us-metal02 before the Mac, the order the owner names them in. */
export const byBoxOrder = <T extends { box: BoxName }>(list: readonly T[]): T[] => [...list].sort((a, b) => Number(a.box === "mac") - Number(b.box === "mac"));

export function sourceText(skill: SkillEntry): string {
  const s = skill.source;
  switch (s.kind) {
    case "git":
      return `${s.repo} ${s.path}`;
    case "upstream":
      return s.package;
    case "harness":
      return `harness ${s.entryKind} ${s.entryId}`;
    case "local":
      return `${boxLabel(s.box)} ${tilde(s.path)}`;
  }
}

const ROLE_LABEL: Record<CopyRole, string> = { source: "source", checkout: "another checkout", install: "install", unowned: "no owner" };
export const roleLabel = (role: CopyRole): string => ROLE_LABEL[role];

export const tilde = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

const under = (path: string, folder: string): boolean => path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

export type CopyRef = { skill: SkillEntry; copy: SkillCopy };

export function copiesByBox(view: SkillsView): Map<BoxName, CopyRef[]> {
  const out = new Map<BoxName, CopyRef[]>();
  for (const skill of view.skills) {
    for (const copy of skill.copies) {
      const list = out.get(copy.box);
      if (list) list.push({ skill, copy });
      else out.set(copy.box, [{ skill, copy }]);
    }
  }
  return out;
}

export const copiesUnder = (refs: readonly CopyRef[], folder: string): CopyRef[] => refs.filter(ref => under(ref.copy.path, folder));

/**
 * A folder of the tree as the layout draws it: its counts, whether it is an old clone, and its children split into live folders and the
 * old clones under it, which draw as one folded clutter group.
 */
export type Folder = {
  box: BoxName;
  node: SkillTreeNode;
  name: string;
  skills: number;
  broken: number;
  /** Links elsewhere on the box that point into this folder, which is how Prime reads a source folder no tool lists. */
  linkedIn: number;
  /** Every copy under it sits in a checkout older than the newest one of its repo by `staleCheckoutDays`. */
  stale: boolean;
  problems: Record<Problem, number>;
  children: Folder[];
  clutter: Folder[];
};

const hasProblem = (skill: SkillEntry, problem: Problem, copyId: string | null): boolean =>
  skill.verdicts.some(v => (COUNT_RULES[problem] as readonly string[]).includes(v.rule) && (copyId === null || v.copyId === null || v.copyId === copyId));

function linkedInto(refs: readonly CopyRef[], inside: readonly CopyRef[], folder: string): number {
  const real = new Set(inside.filter(r => r.copy.link === null).map(r => r.copy.realPath));
  return refs.filter(r => r.copy.link !== null && !under(r.copy.path, folder) && (real.has(r.copy.realPath) || under(r.copy.realPath, folder))).length;
}

const LONG_SEGMENT = 32;

/** A folder name with each very long segment, such as a release hash, cut to its start; the full path goes in a tooltip. */
export const shortName = (name: string): string =>
  name.split("/").map(part => (part.length > LONG_SEGMENT ? `${part.slice(0, 20)}…` : part)).join("/");

export function problemLine(folder: Folder): string {
  return PROBLEM_IDS.filter(p => folder.problems[p] > 0).map(p => `${folder.problems[p]} ${p}`).join(", ");
}

export function folders(box: SkillBoxState, refs: readonly CopyRef[]): Folder[] {
  const build = (node: SkillTreeNode, top: boolean): Folder => {
    const inside = copiesUnder(refs, node.path);
    const kids = node.children.map(child => build(child, false));
    const problems = Object.fromEntries(PROBLEM_IDS.map(p => [p, new Set(inside.filter(r => hasProblem(r.skill, p, r.copy.id)).map(r => r.skill.id)).size])) as Record<Problem, number>;
    return {
      box: box.box,
      node,
      name: top ? tilde(node.path) : node.name,
      skills: node.copies + node.links,
      broken: inside.filter(r => !r.copy.exists).length,
      linkedIn: linkedInto(refs, inside, node.path),
      stale: inside.length > 0 && inside.every(r => r.copy.checkout?.stale === true),
      problems,
      children: kids.filter(k => !k.stale),
      clutter: kids.filter(k => k.stale),
    };
  };
  return box.tree.map(node => build(node, true));
}

export function withProblem(list: readonly Folder[], problem: Problem | null): Folder[] {
  if (problem === null) return [...list];
  return list.filter(f => f.problems[problem] > 0).map(f => ({ ...f, children: withProblem(f.children, problem), clutter: withProblem(f.clutter, problem) }));
}

export function folderLine(folder: Folder): string {
  const who = folder.node.loadedBy.length
    ? folder.node.loadedBy.map(runtimeLabel).join(", ")
    : folder.linkedIn > 0
      ? `read through ${folder.linkedIn} ${folder.linkedIn === 1 ? "link" : "links"}`
      : "nothing loads it";
  const { copies, links } = folder.node;
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const kinds = links === 0 ? plural(copies, "skill folder", "skill folders") : copies === 0 ? plural(links, "link", "links") : `${plural(copies, "folder", "folders")}, ${plural(links, "link", "links")}`;
  return `${who}, ${kinds}`;
}

export function clutterLine(clutter: readonly Folder[]): string {
  const skills = clutter.reduce((sum, f) => sum + f.skills, 0);
  return `${clutter.length} old ${clutter.length === 1 ? "clone" : "clones"}, ${skills} skill ${skills === 1 ? "folder" : "folders"}`;
}

export function findFolder(list: readonly Folder[], path: string): Folder | null {
  for (const folder of list) {
    if (folder.node.path === path) return folder;
    if (under(path, folder.node.path)) return findFolder([...folder.children, ...folder.clutter], path);
  }
  return null;
}

export function ancestors(list: readonly Folder[], path: string): string[] {
  const out: string[] = [];
  let level: readonly Folder[] = list;
  for (;;) {
    const next = level.find(f => f.node.path === path || under(path, f.node.path));
    if (!next) return out;
    out.push(next.node.path);
    if (next.node.path === path) return out;
    level = [...next.children, ...next.clutter];
  }
}

export function roots(list: readonly Folder[]): Folder[] {
  return list.flatMap(f => (f.children.length === 0 && f.clutter.length === 0 ? [f] : roots(f.children)));
}

export type FolderSkill = { skill: SkillEntry; copies: SkillCopy[] };

export function folderSkills(refs: readonly CopyRef[], folder: string): { used: FolderSkill[]; never: FolderSkill[] } {
  const bySkill = new Map<string, FolderSkill>();
  for (const ref of copiesUnder(refs, folder)) {
    const row = bySkill.get(ref.skill.id);
    if (row) row.copies.push(ref.copy);
    else bySkill.set(ref.skill.id, { skill: ref.skill, copies: [ref.copy] });
  }
  const rows = [...bySkill.values()].sort((a, b) => b.skill.use.uses - a.skill.use.uses || a.skill.name.localeCompare(b.skill.name));
  return { used: rows.filter(r => r.skill.use.uses > 0), never: rows.filter(r => r.skill.use.uses === 0) };
}

export const skillProblems = (skill: SkillEntry, copyId: string | null = null): Problem[] => PROBLEM_IDS.filter(p => hasProblem(skill, p, copyId));

export function verdictsOf(skill: SkillEntry, copyId: string | null): SkillVerdictRow[] {
  return skill.verdicts.filter(v => v.copyId === copyId);
}

export function sizeText(bytes: number | null, thresholds: SkillThresholds): string | null {
  if (bytes === null || thresholds.medianBytes <= 0) return null;
  const ratio = bytes / thresholds.medianBytes;
  if (ratio < 0.95) return `${ratio < 0.1 ? "under 0.1" : ratio.toFixed(1)}× median`;
  if (ratio < 1.05) return "median size";
  return `${ratio.toFixed(1)}× median`;
}

export const isBloated = (bytes: number | null, thresholds: SkillThresholds): boolean => bytes !== null && bytes > thresholds.bloatBytes;

export const kb = (bytes: number): string => (bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} kB`);

export function driftText(copy: SkillCopy): string {
  if (copy.role === "source") return "the source";
  if (!copy.exists) return "broken link";
  if (copy.changedLines === null) return "not compared";
  if (copy.changedLines === 0) return "same as source";
  return `${copy.changedLines} ${copy.changedLines === 1 ? "line differs" : "lines differ"} from source`;
}

export const usesText = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "use" : "uses"}`;

export { boxStateLine as boxLine } from "../../box-line.ts";

export type TreeRow = { id: string; parent: string | null; expandable: boolean };

/** Every visible row of the tree in screen order, given which ids are open. Ids are `<box>:<path>` for a folder and `<box>:<path>#clutter` for a clutter group. */
export function visibleRows(boxes: readonly { box: BoxName; folders: readonly Folder[] }[], open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly Folder[], parent: string): void => {
    for (const f of list) {
      const id = folderKey(f.box, f.node.path);
      const expandable = f.children.length > 0 || f.clutter.length > 0;
      rows.push({ id, parent, expandable });
      if (!expandable || !open.has(id)) continue;
      walk(f.children, id);
      if (f.clutter.length === 0) continue;
      const group = clutterKey(id);
      rows.push({ id: group, parent: id, expandable: true });
      if (open.has(group)) walk(f.clutter, group);
    }
  };
  for (const b of boxes) {
    const id = boxKey(b.box);
    rows.push({ id, parent: null, expandable: b.folders.length > 0 });
    if (open.has(id)) walk(b.folders, id);
  }
  return rows;
}

export const folderKey = (box: BoxName, path: string): string => `${box}:${path}`;
export const clutterKey = (folder: string): string => `${folder}#clutter`;
export const boxKey = (box: BoxName): string => `box:${box}`;

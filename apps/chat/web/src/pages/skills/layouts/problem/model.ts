import { THREAD_KINDS, type CopyRole, type SkillCopy, type SkillEntry, type SkillSight, type SkillSource, type SkillThresholds, type SkillVerdictRow, type ThreadKind, type VerdictRule } from "../../../../lib/api/shared/skills.ts";

export const PROBLEMS = ["duplicated", "outdated", "bloated"] as const;
export type Problem = (typeof PROBLEMS)[number];

export type Extra = "broken" | "name-clash";
export type GroupKind = Problem | Extra;

const RULES = {
  duplicated: ["duplicate", "near-duplicate"],
  outdated: ["outdated", "stale-clone"],
  bloated: ["bloated"],
  broken: ["broken"],
  "name-clash": ["name-clash"],
} as const satisfies Record<GroupKind, readonly VerdictRule[]>;

export const GROUP_TEXT: Record<GroupKind, { title: string; description: string }> = {
  duplicated: { title: "Duplicated", description: "A second folder with the same or nearly the same text. Most extra copies first." },
  outdated: { title: "Outdated", description: "A copy that differs from its source or sits in an old clone. Most changed lines first." },
  bloated: { title: "Bloated", description: "A SKILL.md over 3 times the median size of our skills. Largest first." },
  broken: { title: "Broken", description: "A link whose target is gone, or a SKILL.md that names missing paths." },
  "name-clash": { title: "Same name, different skill", description: "Two skills share a name but less than half their lines match." },
};

const ORDER: readonly GroupKind[] = [...PROBLEMS, "broken", "name-clash"];

export const verdictsOf = (skill: SkillEntry, kind: GroupKind): SkillVerdictRow[] =>
  skill.verdicts.filter(v => (RULES[kind] as readonly VerdictRule[]).includes(v.rule));

export const has = (skill: SkillEntry, kind: GroupKind): boolean => verdictsOf(skill, kind).length > 0;

export const problemsOf = (skill: SkillEntry): GroupKind[] => ORDER.filter(kind => has(skill, kind));

export function severity(skill: SkillEntry, kind: GroupKind): number {
  const rows = verdictsOf(skill, kind);
  switch (kind) {
    case "duplicated":
      return rows.filter(v => v.copyId !== null).length * 1000 + rows.length;
    case "outdated": {
      const ids = new Set(rows.map(v => v.copyId));
      return skill.copies.filter(c => ids.has(c.id)).reduce((sum, c) => sum + (c.changedLines ?? 1), 0);
    }
    case "bloated":
      return skill.size.ratio ?? 0;
    case "broken":
    case "name-clash":
      return rows.length;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export type RowActions = {
  removeCopy: (skill: SkillEntry, copy: SkillCopy) => void;
  removeSkill: (skill: SkillEntry) => void;
  adopt: (skill: SkillEntry, copy: SkillCopy) => void;
  move: (skill: SkillEntry, copy: SkillCopy) => void;
  merge: (skill: SkillEntry, into: string) => void;
  install: (skill: SkillEntry) => void;
};

export type Group = { kind: GroupKind; skills: SkillEntry[] };

const matches = (skill: SkillEntry, words: readonly string[]): boolean => {
  const hay = [skill.name, skill.description, skill.id, ...skill.copies.map(c => `${c.box} ${c.path}`)].join(" ").toLowerCase();
  return words.every(word => hay.includes(word));
};

const wordsOf = (text: string): string[] => text.toLowerCase().split(/\s+/).filter(Boolean);

export function problemGroups(skills: readonly SkillEntry[], only: Problem | null, text: string): Group[] {
  const words = wordsOf(text);
  return ORDER.filter(kind => only === null || kind === only).flatMap(kind => {
    const list = skills
      .filter(skill => has(skill, kind) && matches(skill, words))
      .sort((a, b) => severity(b, kind) - severity(a, kind) || b.use.uses - a.use.uses || a.name.localeCompare(b.name));
    return list.length ? [{ kind, skills: list }] : [];
  });
}

export function healthy(skills: readonly SkillEntry[], text: string): SkillEntry[] {
  const words = wordsOf(text);
  return skills
    .filter(skill => problemsOf(skill).length === 0 && matches(skill, words))
    .sort((a, b) => b.use.uses - a.use.uses || a.name.localeCompare(b.name));
}

export const weakDescription = (skill: SkillEntry): boolean => skill.verdicts.some(v => v.rule === "unused" && v.action === "review-description");

const ROLE_RANK: Record<CopyRole, number> = { source: 0, install: 1, checkout: 2, unowned: 3 };

export const orderedCopies = (skill: SkillEntry): SkillCopy[] =>
  [...skill.copies].sort((a, b) => Number(a.checkout?.stale ?? false) - Number(b.checkout?.stale ?? false) || ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.box.localeCompare(b.box) || a.path.localeCompare(b.path));

export const ROLE_TEXT: Record<CopyRole, string> = { source: "source", install: "install", checkout: "other checkout", unowned: "no DB row" };

export function shape(copy: SkillCopy): string {
  if (copy.link === null) return copy.files !== null && copy.files > 1 ? `folder, ${copy.files} files` : "folder";
  return copy.exists ? `link to ${tilde(copy.link)}` : `broken link to ${tilde(copy.link)}`;
}

export function drift(copy: SkillCopy): { text: string; changed: boolean } {
  if (copy.role === "source") return { text: "source", changed: false };
  if (copy.changedLines === null) return { text: "not compared", changed: false };
  if (copy.changedLines === 0) return { text: "same as source", changed: false };
  return { text: `${copy.changedLines.toLocaleString("en-US")} lines changed`, changed: true };
}

export function kb(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
}

export function sizeText(bytes: number | null, limits: SkillThresholds): { text: string; ratio: number | null; bloated: boolean } | null {
  if (bytes === null) return null;
  const ratio = limits.medianBytes > 0 ? bytes / limits.medianBytes : null;
  return { text: ratio === null ? kb(bytes) : `${kb(bytes)}, ${ratio.toFixed(1)}x median`, ratio, bloated: bytes > limits.bloatBytes };
}

export const THREAD_TEXT: Record<ThreadKind, string> = {
  "sw-comm": "sw factory comm",
  "sw-work": "sw factory work",
  "sw-job": "sw factory job",
  "sw-subagent": "sw factory subagent",
  "sw-duty": "sw factory duty",
  "prime-chat": "Prime chat",
  "prime-job": "Prime job",
  "prime-subagent": "Prime subagent",
  "prime-duty": "Prime duty",
  claude: "Claude Code",
  codex: "Codex",
};

export function sight(sees: readonly SkillSight[]): { listed: string[]; hidden: { kind: string; why: string }[] } {
  const listed: string[] = [];
  const hidden: { kind: string; why: string }[] = [];
  for (const s of sees) {
    switch (s.how) {
      case "listed":
        listed.push(THREAD_TEXT[s.kind]);
        break;
      case "imported":
        listed.push(`${THREAD_TEXT[s.kind]} (imported)`);
        break;
      case "inlined":
        listed.push(`${THREAD_TEXT[s.kind]} (full text)`);
        break;
      case "cwd":
        listed.push(`${THREAD_TEXT[s.kind]} in ${s.repo}`);
        break;
      case "hidden":
        hidden.push({ kind: THREAD_TEXT[s.kind], why: s.why });
        break;
      default: {
        const _exhaustive: never = s;
        return _exhaustive;
      }
    }
  }
  return { listed, hidden };
}

export const topKinds = (skill: SkillEntry): { kind: string; uses: number }[] =>
  THREAD_KINDS.flatMap(kind => {
    const use = skill.use.byKind[kind];
    return use && use.uses > 0 ? [{ kind: THREAD_TEXT[kind], uses: use.uses }] : [];
  })
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 3);

export const mergeInto = (skill: SkillEntry, copy: SkillCopy): string | null =>
  skill.verdicts.find(v => v.action === "merge" && v.copyId === copy.id && v.other !== null)?.other ?? null;

export const copyNotes = (skill: SkillEntry, copy: SkillCopy): SkillVerdictRow[] => skill.verdicts.filter(v => v.copyId === copy.id);

export const tilde = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

export function splitPath(path: string): { head: string; tail: string } {
  const cut = path.lastIndexOf("/", path.length - 2);
  return cut <= 0 ? { head: "", tail: path } : { head: path.slice(0, cut + 1), tail: path.slice(cut + 1) };
}

export function headline(skill: SkillEntry, kind: GroupKind, limits: SkillThresholds): string {
  const rows = verdictsOf(skill, kind);
  switch (kind) {
    case "duplicated": {
      const extra = rows.filter(v => v.copyId !== null).length;
      const others = new Set(rows.filter(v => v.copyId === null && v.other !== null).map(v => v.other)).size;
      const parts = [extra ? `${extra} extra ${extra === 1 ? "copy" : "copies"}` : "", others ? `${others} other ${others === 1 ? "skill matches" : "skills match"} its text` : ""];
      return parts.filter(Boolean).join(", ");
    }
    case "outdated": {
      const lines = severity(skill, kind);
      return `${rows.length} ${rows.length === 1 ? "copy" : "copies"} behind, ${lines.toLocaleString("en-US")} lines changed`;
    }
    case "bloated":
      return sizeText(skill.size.bytes, limits)?.text ?? rows[0]?.detail ?? "";
    case "broken":
    case "name-clash":
      return rows[0]?.detail ?? "";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function names(skills: readonly SkillEntry[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const s of skills) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  return new Map(skills.map(s => [s.id, (seen.get(s.name) ?? 0) > 1 ? `${s.name} in ${shortSource(s.source)}` : s.name]));
}

function shortSource(source: SkillSource): string {
  switch (source.kind) {
    case "git":
      return source.repo;
    case "upstream":
      return source.package;
    case "harness":
      return "the harness";
    case "local":
      return splitPath(source.path).head.replace(/\/$/, "").split("/").slice(-2).join("/") || source.box;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export function sourceText(source: SkillSource): string {
  switch (source.kind) {
    case "git":
      return `${source.repo}/${source.path}`;
    case "upstream":
      return `package ${source.package}`;
    case "harness":
      return `harness ${source.entryKind} ${source.entryId}`;
    case "local":
      return `${source.box}:${source.path}, in no repo`;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

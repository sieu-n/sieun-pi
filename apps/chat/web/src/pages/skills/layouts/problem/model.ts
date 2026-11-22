import { COUNT_RULES, THREAD_KINDS, type CopyRole, type SkillCopy, type SkillEntry, type SkillSight, type SkillSource, type SkillThresholds, type SkillVerdictRow, type ThreadKind, type VerdictRule } from "../../../../lib/api/shared/skills.ts";

export type Problem = keyof typeof COUNT_RULES;
export const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const PROBLEMS: readonly Problem[] = ["duplicated", "outdated", "bloated"];

export type Extra = "broken" | "name-clash";
export type GroupKind = Problem | Extra;

const RULES = {
  ...COUNT_RULES,
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
    case "duplicated": {
      const { twins, others } = duplicates(skill);
      return twins.length * 1000 + others.length;
    }
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
  if (copy.link === null) return copy.files !== null && copy.files > 1 ? `folder, ${count(copy.files, "file")}` : "folder";
  return copy.exists ? `link to ${tilde(copy.link)}` : `broken link to ${tilde(copy.link)}`;
}

export function drift(copy: SkillCopy): { text: string; changed: boolean } {
  if (copy.role === "source") return { text: "source", changed: false };
  if (copy.changedLines === null) return { text: "not compared", changed: false };
  if (copy.changedLines === 0) return { text: "same as source", changed: false };
  return { text: `${count(copy.changedLines, "line")} changed`, changed: true };
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

export function kindsText(kinds: readonly ThreadKind[]): string {
  const set = new Set(kinds);
  const sw = THREAD_KINDS.filter(k => k.startsWith("sw-"));
  const prime = THREAD_KINDS.filter(k => k.startsWith("prime-"));
  const parts: string[] = [];
  const allSw = sw.every(k => set.has(k));
  const allPrime = prime.every(k => set.has(k));
  if (allSw) parts.push("every sw factory thread");
  if (allPrime) parts.push("every Prime thread");
  for (const k of THREAD_KINDS) if (set.has(k) && !(allSw && sw.includes(k)) && !(allPrime && prime.includes(k))) parts.push(THREAD_TEXT[k]);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

export function sight(sees: readonly SkillSight[]): string[] {
  const groups = new Map<string, ThreadKind[]>();
  const add = (key: string, kind: ThreadKind) => groups.set(key, [...(groups.get(key) ?? []), kind]);
  for (const s of sees) {
    switch (s.how) {
      case "listed":
      case "imported":
      case "inlined":
        add(s.how, s.kind);
        break;
      case "cwd":
        add(`cwd\u0000${s.repo}`, s.kind);
        break;
      case "hidden":
        add(`hidden\u0000${s.why}`, s.kind);
        break;
      default: {
        const _exhaustive: never = s;
        return _exhaustive;
      }
    }
  }
  const lines: string[] = [];
  for (const [key, kinds] of groups) {
    const [how, extra] = key.split("\u0000");
    const who = kindsText(kinds);
    if (how === "listed") lines.push(`Listed for ${who}.`);
    else if (how === "imported") lines.push(`Listed and pre-imported for ${who}.`);
    else if (how === "inlined") lines.push(`Full text in the prompt of ${who}.`);
    else if (how === "cwd") lines.push(`Listed for ${who} when the folder is ${extra}.`);
    else lines.push(`Hidden from ${who}, because ${(extra ?? "").replace("this kind reads", kinds.length > 1 ? "they read" : "it reads")}.`);
  }
  const rank = (line: string) => (line.startsWith("Hidden") ? 1 : 0);
  return lines.sort((a, b) => rank(a) - rank(b));
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

export const copyNotes = (skill: SkillEntry, copy: SkillCopy): SkillVerdictRow[] => skill.verdicts.filter(v => v.copyId === copy.id && v.rule !== "bloated");

export const tilde = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

export function splitPath(path: string): { head: string; tail: string } {
  const cut = path.lastIndexOf("/", path.length - 2);
  return cut <= 0 ? { head: "", tail: path } : { head: path.slice(0, cut + 1), tail: path.slice(cut + 1) };
}

export function duplicates(skill: SkillEntry): { twins: SkillEntry["extraCopies"]; others: { id: string; same: boolean }[] } {
  const own = new Set(skill.copies.map(c => c.id));
  const others = new Map<string, boolean>();
  for (const v of verdictsOf(skill, "duplicated")) if (v.other !== null && !own.has(v.other)) others.set(v.other, (others.get(v.other) ?? false) || v.rule === "duplicate");
  return { twins: skill.extraCopies.filter(e => e.why !== "stale-clone"), others: [...others].map(([id, same]) => ({ id, same })) };
}

export function shortCopy(copyId: string): string {
  const cut = copyId.indexOf(":");
  const parts = tilde(copyId.slice(cut + 1)).split("/").filter(Boolean).map(part => (part.length > 20 ? `${part.slice(0, 8)}…` : part));
  return `${copyId.slice(0, cut)}:${parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : parts.join("/")}`;
}

export function extraNote(skill: SkillEntry, copy: SkillCopy): string | null {
  const extra = skill.extraCopies.find(e => e.copyId === copy.id);
  if (!extra) return null;
  const kept = shortCopy(extra.keptId);
  switch (extra.why) {
    case "same-text":
      return `Extra copy with the same text as ${kept}, which stays.`;
    case "other-text":
      return `Extra copy whose text differs from ${kept}, which stays.`;
    case "stale-clone":
      return `Extra copy in an old clone; ${kept} stays.`;
    default: {
      const _exhaustive: never = extra.why;
      return _exhaustive;
    }
  }
}

export function headline(skill: SkillEntry, kind: GroupKind, limits: SkillThresholds, nameOf: (id: string) => string): string {
  const rows = verdictsOf(skill, kind);
  switch (kind) {
    case "duplicated": {
      const { twins, others } = duplicates(skill);
      const first = others[0];
      const parts = [
        twins.length ? `${count(twins.length, "extra copy", "extra copies")} of ${shortCopy(twins[0]!.keptId)}` : "",
        others.length === 1 && first ? `${first.same ? "same text as" : "nearly the same text as"} ${nameOf(first.id)}` : "",
        others.length > 1 ? `same or nearly the same text as ${others.length} other skills` : "",
      ];
      return parts.filter(Boolean).join(", ");
    }
    case "outdated": {
      const lines = severity(skill, kind);
      return `${count(rows.length, "copy", "copies")} behind, ${count(lines, "line")} changed`;
    }
    case "bloated":
      return sizeText(skill.size.bytes, limits)?.text ?? rows[0]?.detail ?? "";
    case "broken":
      return rows[0]?.detail ?? "";
    case "name-clash": {
      const others = new Set(rows.map(v => v.other)).size;
      return `${others} other ${others === 1 ? "skill has" : "skills have"} this name and different text`;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function names(skills: readonly SkillEntry[]): Map<string, string> {
  const tally = (labels: Map<string, string>) => {
    const seen = new Map<string, number>();
    for (const label of labels.values()) seen.set(label, (seen.get(label) ?? 0) + 1);
    return seen;
  };
  const byName = new Map(skills.map(s => [s.id, s.name]));
  const nameSeen = tally(byName);
  const bySource = new Map(skills.map(s => [s.id, (nameSeen.get(s.name) ?? 0) > 1 ? `${s.name} in ${shortSource(s.source)}` : s.name]));
  const sourceSeen = tally(bySource);
  return new Map(skills.map(s => {
    const label = bySource.get(s.id) ?? s.name;
    return [s.id, (sourceSeen.get(label) ?? 0) > 1 && s.source.kind === "git" ? `${s.name} in ${s.source.repo}/${splitPath(s.source.path).head.replace(/\/$/, "")}` : label];
  }));
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

export function sourceBox(skills: readonly SkillEntry[]): string | null {
  const tally = new Map<string, number>();
  for (const skill of skills) for (const c of skill.copies) if (c.role === "source") tally.set(c.box, (tally.get(c.box) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function openedByPath(skill: SkillEntry): ThreadKind[] {
  const listed = new Set(skill.sees.filter(s => s.how !== "hidden").map(s => s.kind));
  return THREAD_KINDS.filter(kind => (skill.use.byKind[kind]?.uses ?? 0) > 0 && !listed.has(kind));
}

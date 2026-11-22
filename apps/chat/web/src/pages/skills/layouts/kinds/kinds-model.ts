import {
  COUNT_RULES, THREAD_KINDS, type InstallState, type SkillBoxState, type SkillCopy, type SkillEntry, type SkillInstall, type SkillSight, type SkillThresholds,
  type SkillsView, type ThreadKind, type VerdictRule,
} from "../../../../lib/api/shared/skills.ts";


export type Problem = "duplicated" | "outdated" | "bloated" | "unused";
export type Filter = "all" | Problem;


export const PROBLEMS: readonly { id: Problem; label: string; hint: string }[] = [
  { id: "duplicated", label: "Duplicated", hint: "A copy with the same text as its source, or 0.5 line similarity or more" },
  { id: "outdated", label: "Outdated", hint: "A copy that differs from its git source, or sits in an old clone nothing loads" },
  { id: "bloated", label: "Bloated", hint: "A SKILL.md over 3 times the median bytes of our skills" },
  { id: "unused", label: "Never used", hint: "No thread opened the SKILL.md or called its module in 30 days" },
];

export function problemsOf(entry: SkillEntry, usageCounted: boolean): Problem[] {
  const rules = new Set(entry.verdicts.map(v => v.rule));
  const out: Problem[] = [];
  for (const problem of ["duplicated", "outdated", "bloated"] as const) {
    const list: readonly VerdictRule[] = COUNT_RULES[problem];
    if (list.some(rule => rules.has(rule))) out.push(problem);
  }
  if (usageCounted && entry.source.kind !== "harness" && entry.use.uses === 0) out.push("unused");
  return out;
}

export function problemCount(view: SkillsView, problem: Problem): number {
  switch (problem) {
    case "duplicated": return view.counts.duplicated;
    case "outdated": return view.counts.outdated;
    case "bloated": return view.counts.bloated;
    case "unused": return view.counts.neverUsed;
    default: {
      const _exhaustive: never = problem;
      return _exhaustive;
    }
  }
}

export type Family = "sw factory" | "Prime" | "Claude Code" | "Codex";

export const KIND_META: Record<ThreadKind, { family: Family; label: string; name: string }> = {
  "sw-comm": { family: "sw factory", label: "comm", name: "sw factory comm thread" },
  "sw-work": { family: "sw factory", label: "work", name: "sw factory work thread" },
  "sw-job": { family: "sw factory", label: "job", name: "sw factory job" },
  "sw-subagent": { family: "sw factory", label: "subagent", name: "sw factory subagent" },
  "sw-duty": { family: "sw factory", label: "duty run", name: "sw factory duty run" },
  "prime-chat": { family: "Prime", label: "chat", name: "Prime chat" },
  "prime-job": { family: "Prime", label: "job", name: "Prime job" },
  "prime-subagent": { family: "Prime", label: "subagent", name: "Prime subagent" },
  "prime-duty": { family: "Prime", label: "duty run", name: "Prime duty run" },
  claude: { family: "Claude Code", label: "session", name: "Claude Code session" },
  codex: { family: "Codex", label: "session", name: "Codex session" },
};

export function families(): { family: Family; span: number }[] {
  const out: { family: Family; span: number }[] = [];
  for (const kind of THREAD_KINDS) {
    const family = KIND_META[kind].family;
    const last = out.at(-1);
    if (last?.family === family) last.span++;
    else out.push({ family, span: 1 });
  }
  return out;
}

/**
 * Prime's skill list writes each skill as a `<skill>` block with its name, description and location; this is the tag text around them.
 * The token estimate counts 4 characters a token, the usual rate for English text.
 */
const LIST_BLOCK_CHARS = "<skill>\n<name></name>\n<description></description>\n<location></location>\n</skill>\n".length;
const CHARS_PER_TOKEN = 4;

export type KindColumn = {
  kind: ThreadKind;
  label: string;
  name: string;
  listed: number;
  imported: number;
  inlined: number;
  cwd: { repo: string; count: number }[];
  tokens: number;
};

export function kindColumns(view: SkillsView): KindColumn[] {
  const paths = new Map(view.skills.flatMap(s => s.copies.map(c => [c.id, c.path] as const)));
  return THREAD_KINDS.map(kind => {
    let listed = 0;
    let imported = 0;
    let inlined = 0;
    let chars = 0;
    const cwd = new Map<string, number>();
    for (const entry of view.skills) {
      const sight = sightFor(entry, kind);
      if (sight.how === "hidden") continue;
      if (sight.how === "cwd") {
        cwd.set(sight.repo, (cwd.get(sight.repo) ?? 0) + 1);
        continue;
      }
      listed++;
      if (sight.how === "imported") imported++;
      if (sight.how === "inlined") {
        inlined++;
        chars += entry.size.bytes ?? 0;
        continue;
      }
      chars += LIST_BLOCK_CHARS + entry.name.length + entry.description.length + (paths.get(sight.copyId)?.length ?? 0);
    }
    return {
      kind, label: KIND_META[kind].label, name: KIND_META[kind].name, listed, imported, inlined,
      cwd: [...cwd].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count),
      tokens: Math.round(chars / CHARS_PER_TOKEN),
    };
  });
}

export function columnTitle(column: KindColumn): string {
  const lines = [
    `${column.name}: ${column.listed} skills in every prompt${column.imported ? `, ${column.imported} with a pre-imported Python module` : ""}${column.inlined ? `, ${column.inlined} with its whole text` : ""}.`,
    `About ${column.tokens.toLocaleString("en-US")} tokens for their names, descriptions and paths${column.inlined ? " and the inlined text" : ""}, at ${CHARS_PER_TOKEN} characters a token.`,
  ];
  for (const { repo, count } of column.cwd) lines.push(`${count} more when the thread's folder is ${repo}.`);
  return lines.join("\n");
}

export function tokensLabel(tokens: number): string {
  return tokens >= 1000 ? `≈${(tokens / 1000).toFixed(1)}k tokens` : `≈${tokens} tokens`;
}

const HIDDEN_DEFAULT = "No folder this kind of thread reads holds it";

export function sightFor(entry: SkillEntry, kind: ThreadKind): SkillSight {
  return entry.sees.find(s => s.kind === kind) ?? { kind, how: "hidden", why: HIDDEN_DEFAULT };
}

export type CellTone = "listed" | "imported" | "inlined" | "cwd" | "hidden";
export type Cell = { tone: CellTone; label: string; title: string };

export function cellFor(entry: SkillEntry, kind: ThreadKind): Cell {
  const sight = sightFor(entry, kind);
  const who = KIND_META[kind].name;
  const from = (copyId: string): string => entry.copies.find(c => c.id === copyId)?.path ?? copyId;
  switch (sight.how) {
    case "listed": return { tone: "listed", label: "listed", title: `Every ${who} lists it by name and description, from ${from(sight.copyId)}` };
    case "imported": return { tone: "imported", label: "pre-imported", title: `Every ${who} lists it and pre-imports its Python module, from ${from(sight.copyId)}` };
    case "inlined": return { tone: "inlined", label: "inlined", title: `Every ${who} carries its whole SKILL.md in the prompt, from ${from(sight.copyId)}` };
    case "cwd": return { tone: "cwd", label: `in ${repoName(sight.repo)}`, title: `A ${who} lists it only when its folder is ${sight.repo}, from ${from(sight.copyId)}` };
    case "hidden": return { tone: "hidden", label: "hidden", title: sight.why };
    default: {
      const _exhaustive: never = sight;
      return _exhaustive;
    }
  }
}

const repoName = (repo: string): string => repo.split("/").filter(Boolean).at(-1) ?? repo;

export type Row = { entry: SkillEntry; problems: Problem[] };

export function rowsFor(view: SkillsView, filter: Filter, text: string): Row[] {
  const q = text.trim().toLowerCase();
  const usageCounted = view.counts.neverUsed > 0;
  return view.skills
    .map(entry => ({ entry, problems: problemsOf(entry, usageCounted) }))
    .filter(row => filter === "all" || row.problems.includes(filter))
    .filter(row => !q || matches(row.entry, q))
    .sort((a, b) => b.entry.use.uses - a.entry.use.uses || b.entry.use.sessions - a.entry.use.sessions || a.entry.name.localeCompare(b.entry.name));
}

function matches(entry: SkillEntry, q: string): boolean {
  if (entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q)) return true;
  return entry.copies.some(c => `${c.box}:${c.path}`.toLowerCase().includes(q));
}

export function usesLabel(entry: SkillEntry, unused: boolean): string {
  const { uses, sessions } = entry.use;
  if (uses === 0) return unused ? "No thread used it in 30 days" : "No use counted";
  return `${uses.toLocaleString("en-US")} ${uses === 1 ? "use" : "uses"} in ${sessions.toLocaleString("en-US")} ${sessions === 1 ? "session" : "sessions"} over 30 days`;
}

export function usesTitle(entry: SkillEntry): string {
  const by = Object.entries(entry.use.byKind)
    .flatMap(([kind, n]) => (n && n.uses > 0 ? [{ kind: kind as ThreadKind, uses: n.uses }] : []))
    .sort((a, b) => b.uses - a.uses)
    .map(({ kind, uses }) => `${KIND_META[kind].name}: ${uses.toLocaleString("en-US")}`);
  const last = entry.use.lastUse ? `Last use ${entry.use.lastUse.slice(0, 10)}.` : "No use in 30 days.";
  return [last, ...by].join("\n");
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} kB`;
}

export type Size = { label: string; ratio: string | null; bloated: boolean; title: string };

export function sizeOf(bytes: number | null, lines: number | null, thresholds: SkillThresholds, folderBytes: number | null = null): Size | null {
  if (bytes === null) return null;
  const ratio = thresholds.medianBytes > 0 ? bytes / thresholds.medianBytes : null;
  const bloated = bytes > thresholds.bloatBytes;
  const title = [
    `${bytes.toLocaleString("en-US")} bytes${lines === null ? "" : `, ${lines.toLocaleString("en-US")} lines`}.`,
    `The median of our skills is ${thresholds.medianBytes.toLocaleString("en-US")} bytes; over ${thresholds.bloatBytes.toLocaleString("en-US")} is bloated.`,
    ...(folderBytes !== null && folderBytes !== bytes ? [`The whole folder, with its scripts and references, is ${bytesLabel(folderBytes)}.`] : []),
  ].join("\n");
  return { label: bytesLabel(bytes), ratio: ratio === null ? null : `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}× median`, bloated, title };
}

export const ROLE_LABEL: Record<SkillCopy["role"], string> = { source: "source", checkout: "other checkout", install: "install", unowned: "no owner" };

export type Drift = { label: string; tone: "ok" | "warn" | "bad" | "muted"; title: string };

export function driftOf(copy: SkillCopy, install: SkillInstall | null): Drift {
  if (!copy.exists) return { label: "broken link", tone: "bad", title: `The link points at ${copy.link ?? "a folder"} that is gone` };
  if (install) {
    const state = installDrift(install.state);
    if (state) return state;
  }
  if (copy.role === "source") return { label: "source", tone: "muted", title: "The text every other copy is compared with" };
  const stale = copy.checkout?.stale ? copy.checkout : null;
  const age = stale?.headAt ? `, last commit ${stale.headAt.slice(0, 10)}` : "";
  if (copy.changedLines === null) return { label: stale ? "old clone" : "not compared", tone: stale ? "warn" : "muted", title: stale ? `In ${stale.root}${age}` : "One of the two texts did not read" };
  if (copy.changedLines === 0) {
    return stale ? { label: "old clone, same text", tone: "warn", title: `In ${stale.root}${age}` } : { label: "same as source", tone: "ok", title: "Same text as the source" };
  }
  const lines = `${copy.changedLines} ${copy.changedLines === 1 ? "line differs" : "lines differ"}`;
  return { label: stale ? `old clone, ${lines}` : lines, tone: "warn", title: stale ? `In ${stale.root}${age}` : "Lines added plus lines removed against the source" };
}

function installDrift(state: InstallState): Drift | null {
  switch (state.kind) {
    case "ok": return null;
    case "missing": return { label: "install missing", tone: "bad", title: "The DB wants this install and the disk lacks it; apply puts it back" };
    case "wrong-link": return { label: "link points elsewhere", tone: "bad", title: `It points at ${state.target ?? "nothing"}; apply relinks it` };
    case "changed": return { label: `edited here, ${state.changedLines} lines`, tone: "warn", title: "Edited in place since it was placed; adopt keeps the edit, remove drops it" };
    case "behind": return { label: `behind source, ${state.changedLines} lines`, tone: "warn", title: "The source moved on since this copy was placed; apply refreshes it" };
    case "unknown": return { label: "not scanned", tone: "muted", title: state.reason };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function homeBox(entry: SkillEntry, boxes: readonly SkillBoxState[]): string | null {
  return entry.copies.find(c => c.role === "source")?.box ?? boxes.find(b => b.state === "ok")?.box ?? boxes[0]?.box ?? null;
}

export function sourceLabel(entry: SkillEntry): string {
  const s = entry.source;
  switch (s.kind) {
    case "git": return `${s.repo}/${s.path}`;
    case "upstream": return `package ${s.package}`;
    case "harness": return `harness ${s.entryKind} ${s.entryId}`;
    case "local": return `${s.box}:${s.path}, in no repo`;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

export function ownerLabel(entry: SkillEntry, names: ReadonlyMap<string, string>): string {
  return entry.owner.kind === "owner" ? "the owner" : (names.get(entry.owner.id) ?? entry.owner.id);
}

export function boxNotices(boxes: readonly SkillBoxState[]): { box: string; text: string; error: string | null }[] {
  return boxes.flatMap(b => {
    if (b.state === "ok") return [];
    const text = b.message ?? (b.state === "never" ? `${b.box} has not scanned yet` : `${b.box} is offline${b.lastOkAt ? `, showing its scan from ${b.lastOkAt.slice(0, 16).replace("T", " ")}` : ""}`);
    return [{ box: b.box, text, error: b.error }];
  });
}

export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

export function pathTitle(copy: SkillCopy): string {
  const lines = [copy.path];
  if (copy.link) lines.push(`Links to ${copy.link}`);
  if (copy.realPath && copy.realPath !== copy.path && copy.realPath !== copy.link) lines.push(`The real folder is ${copy.realPath}`);
  return lines.join("\n");
}

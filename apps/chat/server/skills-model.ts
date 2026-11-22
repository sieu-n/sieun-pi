/**
 * The pure side of the skills DB (server/skills-db.ts): the scanner's facts parsed at the edge, which skill each folder on disk belongs to,
 * the rule verdicts, which thread kinds see a skill, and the plan `sw skills apply` runs. Nothing here touches the disk or the database.
 *
 * A skill is one source: a git folder (repo plus path), an upstream package the owner installed, a harness entry, or a local folder that
 * no repo or package holds. Every folder the scanner saw belongs to the source its path and checkout name, and a symlink belongs to the
 * source of the folder it points at.
 */
import { basename, relative } from "node:path";
import {
  SKILL_RUNTIMES, THREAD_KINDS, type ApplyStep, type CopyRole, type DriftItem, type InstallState, type SkillOwner, type SkillRuntime, type SkillSight,
  type SkillSource, type SkillThresholds, type SkillTreeNode, type SkillUse30d, type SkillVerdictRow, type ThreadKind,
} from "../web/src/lib/api/shared/skills.ts";

/** One folder, file or link the scanner saw (scripts/skills-inventory.py `copies`). */
export type FactCopy = {
  box: string;
  path: string;
  realPath: string;
  linkTarget: string | null;
  exists: boolean;
  name: string;
  description: string;
  source: string;
  root: string;
  how: string;
  runtimes: SkillRuntime[];
  hash: string | null;
  lines: number | null;
  /** The SKILL.md's own bytes, which the bloat rule measures. */
  bytes: number | null;
  /** The whole skill folder's bytes, its scripts and references included. */
  folderBytes: number | null;
  files: number | null;
  mtime: string | null;
  skillMd: string | null;
  checkout: { root: string; remote: string | null; branch: string | null; headAt: string | null; upstreamAt: string | null; behind: number; tracked: boolean } | null;
  dmi: boolean;
  pythonImport: string | null;
  deadRefs: string[];
  text: string | null;
};

export type BoxSettings = {
  primeSkills: string[];
  primeBundledSkills: Record<string, boolean>;
  claudeEnabledPlugins: Record<string, boolean>;
  repos: Record<string, string[]>;
};

export type FactBox = { box: string; scannedAt: string | null; ok: boolean; error: string | null; seconds: number | null; settings: BoxSettings | null };

export type FactUse = { uses30d: number; sessions30d: number; lastUse: string | null; byKind: SkillUse30d["byKind"] };

/** `coverage` is the scanner's COVERAGE, which it raises each time it walks more folders; an inventory without it is coverage 1. */
export type Facts = { generatedAt: string | null; coverage: number; boxes: FactBox[]; copies: FactCopy[]; usage: Map<string, FactUse>; usageCounted: boolean };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : []);
const flags = (value: unknown): Record<string, boolean> =>
  isObject(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : {};
const isRuntime = (value: string): value is SkillRuntime => (SKILL_RUNTIMES as readonly string[]).includes(value);
const isKind = (value: string): value is ThreadKind => (THREAD_KINDS as readonly string[]).includes(value);

function parseCopy(raw: Json): FactCopy | null {
  const box = str(raw.box);
  const path = str(raw.path);
  if (!box || !path) return null;
  const kind = str(raw.harnessKind);
  if (kind && kind !== "skill" && kind !== "subagent") return null;
  const checkout = isObject(raw.checkout) && str(raw.checkout.root)
    ? {
      root: String(raw.checkout.root), remote: str(raw.checkout.remote), branch: str(raw.checkout.branch), headAt: str(raw.checkout.headAt),
      upstreamAt: str(raw.checkout.upstreamAt), behind: num(raw.checkout.behind) ?? 0, tracked: raw.checkout.tracked === true,
    }
    : null;
  return {
    box, path, realPath: str(raw.realPath) ?? path, linkTarget: str(raw.linkTarget), exists: raw.exists !== false, name: str(raw.name) ?? basename(path),
    description: str(raw.description) ?? "", source: str(raw.source) ?? "", root: str(raw.root) ?? "", how: str(raw.how) ?? "",
    runtimes: strings(raw.runtimes).filter(isRuntime), hash: str(raw.hash), lines: num(raw.lines),
    bytes: num(raw.skillMdBytes) ?? (num(raw.files) === 1 ? num(raw.sizeBytes) : typeof raw.text === "string" ? Buffer.byteLength(raw.text) : null), folderBytes: num(raw.sizeBytes), files: num(raw.files),
    mtime: str(raw.mtime), skillMd: str(raw.skillMd), checkout, dmi: raw.disableModelInvocation === true, pythonImport: str(raw.pythonImport),
    deadRefs: strings(raw.deadRefs), text: typeof raw.text === "string" ? raw.text : null,
  };
}

function parseSettings(raw: unknown): BoxSettings | null {
  if (!isObject(raw)) return null;
  const repos = isObject(raw.repos) ? Object.fromEntries(Object.entries(raw.repos).map(([repo, list]) => [repo, strings(list)])) : {};
  return { primeSkills: strings(raw.primeSkills), primeBundledSkills: flags(raw.primeBundledSkills), claudeEnabledPlugins: flags(raw.claudeEnabledPlugins), repos };
}

function parseUse(raw: Json): FactUse {
  const byKind: SkillUse30d["byKind"] = {};
  for (const [kind, tally] of Object.entries(isObject(raw.byKind) ? raw.byKind : {})) {
    if (isKind(kind) && isObject(tally)) byKind[kind] = { uses: num(tally.uses) ?? 0, sessions: num(tally.sessions) ?? 0 };
  }
  return { uses30d: num(raw.uses30d) ?? 0, sessions30d: num(raw.sessions30d) ?? 0, lastUse: str(raw.lastUse), byKind };
}

/** The scanner's inventory.json as facts, or null when it carries no `copies` list (a scanner from before the skills DB). */
export function parseFacts(raw: unknown): Facts | null {
  if (!isObject(raw) || !Array.isArray(raw.copies)) return null;
  const boxes = (Array.isArray(raw.boxes) ? raw.boxes : []).filter(isObject).flatMap(b => {
    const box = str(b.box);
    return box ? [{ box, scannedAt: str(b.scannedAt), ok: b.ok !== false, error: str(b.error), seconds: num(b.seconds), settings: parseSettings(b.settings) }] : [];
  });
  const usage = new Map(Object.entries(isObject(raw.usage) ? raw.usage : {}).flatMap(([name, use]) => (isObject(use) ? [[name, parseUse(use)] as const] : [])));
  return { generatedAt: str(raw.generatedAt), coverage: num(raw.coverage) ?? 1, boxes, copies: raw.copies.filter(isObject).flatMap(c => parseCopy(c) ?? []), usage, usageCounted: raw.usageCounted === true };
}

// Which skill a folder belongs to

export type Identity = { key: string; name: string; source: SkillSource };

const RUNTIME_COPY = /\/sieun-pi-runtime\/(?:current|releases\/[^/]+)\/(.+)$/;
const PIHOST_COPY = /\/pi-host\/(?:current|release-[^/]+)\/(packages\/.+)$/;
/**
 * Two link targets name the same skill when they differ only in the sieun-pi runtime or pi-host release folder. prime-sync relinks the Mac's
 * ~/.prime/agent/skills into each new runtime release, which on 11-22 showed 29 links as wrong-link an hour after the seed.
 */
export function sameLink(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const unpin = (t: string) => t.replace(/\/sieun-pi-runtime\/releases\/[^/]+\//, "/sieun-pi-runtime/current/").replace(/\/pi-host\/release-[^/]+\//, "/pi-host/current/");
  return unpin(a) === unpin(b);
}

const PLUGIN = /\/\.(claude|codex)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/skills\//;
const PRIME_BUNDLE = /\/prime-agent\/releases\/[^/]+\/skills\//;

/** The repo a checkout holds: its origin's last path part, else the checkout folder's name. */
export function repoName(checkout: NonNullable<FactCopy["checkout"]>): string {
  const remote = checkout.remote?.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).at(-1);
  return remote || basename(checkout.root);
}

export function sourceKey(source: SkillSource, name: string): string {
  switch (source.kind) {
    case "git":
      return `git:${source.repo}/${source.path}`;
    case "upstream":
      return `upstream:${source.package}/${name}`;
    case "harness":
      return `harness:${source.entryKind}/${source.entryId}`;
    case "local":
      return `local:${source.box}:${source.path}`;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/** The source of a real folder (not a link), from its checkout, then its path. */
export function identifyFolder(copy: Pick<FactCopy, "box" | "path" | "realPath" | "name" | "source" | "checkout">): Identity {
  const name = copy.name;
  const path = copy.realPath;
  const git = (repo: string, rel: string): Identity => ({ key: "", name, source: { kind: "git", repo, path: rel } });
  const up = (pkg: string, url: string | null = null): Identity => ({ key: "", name, source: { kind: "upstream", package: pkg, url } });
  let id: Identity;
  if (copy.source.startsWith("harness-")) {
    const [, kind = "", ...rest] = copy.path.split(":");
    id = { key: "", name, source: { kind: "harness", entryKind: kind, entryId: rest.join(":") } };
  } else if (copy.checkout?.tracked) id = git(repoName(copy.checkout), relative(copy.checkout.root, copy.path));
  else if (RUNTIME_COPY.test(path) || RUNTIME_COPY.test(copy.path)) id = git("sieun-pi", (RUNTIME_COPY.exec(copy.path) ?? RUNTIME_COPY.exec(path))![1]!);
  else if (PIHOST_COPY.test(path) || PIHOST_COPY.test(copy.path)) id = git("sieun-pi", (PIHOST_COPY.exec(copy.path) ?? PIHOST_COPY.exec(path))![1]!);
  else if (PRIME_BUNDLE.test(path)) id = up("prime-agent");
  else if (PLUGIN.test(path)) {
    const [, tool, market, plugin] = PLUGIN.exec(path)!;
    id = up(`${tool}-plugin:${plugin}@${market}`);
  } else if (path.includes("/.codex/skills/.system/")) id = up("codex-system");
  else if (path.includes("/.claude/skills/synced/")) id = up("claude.ai");
  else if (copy.source === "user-dir" && /\/\.agents\/skills\//.test(path) && !copy.checkout) id = up("skills-cli");
  else id = { key: "", name, source: { kind: "local", box: copy.box, path } };
  return { ...id, key: sourceKey(id.source, name) };
}

/** Who a new skill row belongs to: agent factory for sieun-pi's own skills, which it maintains, and the owner for the rest. */
export function seedOwner(source: SkillSource): SkillOwner {
  return source.kind === "git" && source.repo === "sieun-pi" ? { kind: "agent", id: "ag_agent-factory" } : { kind: "owner" };
}

export const ownerText = (owner: SkillOwner): string => (owner.kind === "owner" ? "owner" : owner.id);
export const parseOwner = (text: string): SkillOwner => (text === "owner" ? { kind: "owner" } : { kind: "agent", id: text });

// Text comparison

/** A text over this many cells (two 5000-line files) counts as a whole replace: the LCS table takes 4 bytes a cell, so 100 MB. */
const DIFF_CELLS = 25_000_000;

/** The longest common subsequence of two line lists, after trimming their shared head and tail. */
function common(a: readonly string[], b: readonly string[]): number {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const xs = a.slice(pre, a.length - suf);
  const ys = b.slice(pre, b.length - suf);
  if (xs.length * ys.length > DIFF_CELLS) return pre + suf;
  let prev = new Uint32Array(ys.length + 1);
  let next = new Uint32Array(ys.length + 1);
  for (let i = xs.length - 1; i >= 0; i--) {
    for (let j = ys.length - 1; j >= 0; j--) next[j] = xs[i] === ys[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, next[j + 1]!);
    [prev, next] = [next, prev];
  }
  return pre + suf + prev[0]!;
}

const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** Lines added plus lines removed to turn `a` into `b`. */
export function changedLines(a: string, b: string): number {
  if (a === b) return 0;
  const x = linesOf(a);
  const y = linesOf(b);
  return x.length + y.length - 2 * common(x, y);
}

/** How alike two texts are, from 0 to 1: twice the shared lines over all lines, which difflib's ratio is for lines. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = linesOf(a);
  const y = linesOf(b);
  return x.length + y.length === 0 ? 1 : (2 * common(x, y)) / (x.length + y.length);
}

/** A cheap upper bound on `similarity` from the sets of distinct lines, so only plausible pairs pay for the LCS. */
export function lineOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const line of small) if (big.has(line)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export const lineSet = (text: string): Set<string> => new Set(linesOf(text).map(line => line.trim()).filter(line => line.length > 2));

// Thresholds

/**
 * Bloat is measured in bytes, at 3 times the median SKILL.md of our own skills. On 11-21 our 71 skills had a median of 75 lines and 4,208
 * bytes, and 17 were over 3x the bytes median, while a 3x line limit caught 3, since git-workflow is 272 lines but 94,583 bytes
 * (~/work/skills-tab/skills-tree/findings.md, Bloat). The median is measured again on every scan.
 */
export const BLOAT_FACTOR = 3;
/**
 * Two skills under different sources are near-duplicates at this line similarity or more. Over the same-name pairs of the 11-22 scan, the
 * five copies that only lag behind the skill they came from sat at 0.87 to 0.95, the five that grew into their own skills at 0.60 to 0.80,
 * and the 35 different skills that share a name under 0.5 (~/work/skills-core/near-duplicate.md).
 */
export const NEAR_DUPLICATE = 0.8;
/**
 * A checkout is stale when its last commit is this many days older than the newest commit any checkout of the same repo knows, its own
 * upstream included. On 11-21 the 13 old clones on the Mac were 37 or more days behind (skills-tree findings), metal's slack-green sat 8
 * days and 120 commits behind origin/main with local edits, and the checkouts in daily use had commits from the same day.
 */
export const STALE_CHECKOUT_DAYS = 7;

/** Marks each copy whose checkout is stale against the newest commit of its repo. */
export function staleCheckouts(copies: readonly FactCopy[]): Set<FactCopy> {
  const newest = new Map<string, number>();
  for (const c of copies) {
    if (!c.checkout) continue;
    const repo = repoName(c.checkout);
    const at = Math.max(Date.parse(c.checkout.headAt ?? "") || 0, Date.parse(c.checkout.upstreamAt ?? "") || 0);
    newest.set(repo, Math.max(newest.get(repo) ?? 0, at));
  }
  const out = new Set<FactCopy>();
  for (const c of copies) {
    if (!c.checkout?.headAt) continue;
    const head = Date.parse(c.checkout.headAt);
    if ((newest.get(repoName(c.checkout)) ?? head) - head > STALE_CHECKOUT_DAYS * 86_400_000) out.add(c);
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function thresholds(ours: readonly { lines: number | null; bytes: number | null }[]): SkillThresholds {
  const medianBytes = Math.round(median(ours.flatMap(s => (s.bytes === null ? [] : [s.bytes]))));
  const medianLines = Math.round(median(ours.flatMap(s => (s.lines === null ? [] : [s.lines]))));
  return {
    medianBytes, medianLines, bloatBytes: medianBytes * BLOAT_FACTOR, nearDuplicate: NEAR_DUPLICATE, staleCheckoutDays: STALE_CHECKOUT_DAYS,
    source: `Medians over the source text of our ${ours.length} skills (git and local, old clones left out) at this scan; bloat at ${BLOAT_FACTOR}x the bytes median.`,
  };
}

// What a layout and `sw skills` read

export type SkillRecord = { id: string; name: string; owner: SkillOwner; source: SkillSource; createdAt: string };

export type InstallRecord = {
  id: string;
  skillId: string;
  box: string;
  path: string;
  mode: "link" | "copy";
  /** The link's target as readlink gives it, or the folder a copy is made from. */
  target: string;
  runtimes: SkillRuntime[];
  agent: string | null;
  /** The SKILL.md hash of a copy when it was placed or adopted, and its source's hash then. */
  appliedHash: string | null;
  sourceHash: string | null;
  /** The move whose step for this install still waits for its box. */
  pending: string | null;
};

/** One scanned copy with what the rules derived for it. */
export type CopyFact = FactCopy & { key: string; changedLines: number | null; stale: boolean };

export type BoxScan = { box: string; attemptedAt: string | null; ok: boolean; error: string | null; seconds: number | null; lastOkAt: string | null; since: string | null; settings: BoxSettings | null };

/** The canonical copy of each source key: this box first, then not in an old clone, not a release copy, then the newest commit or file. */
export function canonical(copies: readonly CopyFact[], localBox: string): Map<string, CopyFact> {
  const out = new Map<string, CopyFact>();
  const rank = (c: CopyFact): string => [
    c.box === localBox ? 0 : 1, c.stale ? 1 : 0, RUNTIME_COPY.test(c.path) || PIHOST_COPY.test(c.path) ? 1 : 0, c.exists ? 0 : 1,
    c.checkout?.headAt ?? c.mtime ?? "",
  ].join("|");
  for (const c of copies) {
    if (c.linkTarget !== null || !c.key) continue;
    const cur = out.get(c.key);
    if (!cur) out.set(c.key, c);
    else {
      const [a, b] = [rank(c), rank(cur)];
      const head = (r: string) => r.split("|").slice(0, 4).join("|");
      if (head(a) < head(b) || (head(a) === head(b) && a.split("|")[4]! > b.split("|")[4]!)) out.set(c.key, c);
    }
  }
  return out;
}

/** Which folders hold a copy at each source key's canonical place and which only point at it. */
export function roleOf(copy: CopyFact, skills: ReadonlyMap<string, SkillRecord>, installAt: ReadonlyMap<string, InstallRecord>, canon: ReadonlyMap<string, CopyFact>): CopyRole {
  if (installAt.has(`${copy.box}:${copy.path}`)) return "install";
  if (copy.linkTarget !== null) return "unowned";
  if (!skills.has(copy.key)) return "unowned";
  return canon.get(copy.key) === copy ? "source" : "checkout";
}

export const copyId = (c: { box: string; path: string }): string => `${c.box}:${c.path}`;

/** How an install matches the disk, from its box's last good scan. */
export function installState(install: InstallRecord, at: CopyFact | undefined, scan: BoxScan | undefined, sourceHash: string | null): InstallState {
  if (!scan?.lastOkAt) return { kind: "unknown", reason: `${install.box} has no good scan yet.` };
  if (!at) return { kind: "missing" };
  if (install.mode === "link") return sameLink(at.linkTarget, install.target) ? { kind: "ok" } : { kind: "wrong-link", target: at.linkTarget };
  if (at.hash !== install.appliedHash) return { kind: "changed", changedLines: at.changedLines ?? 0 };
  if (sourceHash !== null && install.sourceHash !== null && sourceHash !== install.sourceHash) return { kind: "behind", changedLines: at.changedLines ?? 0 };
  return { kind: "ok" };
}

/** The steps that make the disk match the installs: create what is missing, point a wrong link back, refresh a copy its source left behind. */
export function plan(installs: readonly InstallRecord[], states: ReadonlyMap<string, InstallState>): Omit<ApplyStep, "result" | "note">[] {
  const steps: Omit<ApplyStep, "result" | "note">[] = [];
  for (const install of installs) {
    if (install.pending) continue;
    const state = states.get(install.id);
    const step = state?.kind === "missing" ? "create" : state?.kind === "wrong-link" ? "relink" : state?.kind === "behind" ? "refresh" : null;
    if (step) steps.push({ installId: install.id, box: install.box, path: install.path, step });
  }
  return steps;
}

/** What `sw skills check` lists: folders with no row, and installs the disk does not match. */
export function drift(copies: readonly CopyFact[], roles: ReadonlyMap<string, CopyRole>, installs: readonly InstallRecord[], states: ReadonlyMap<string, InstallState>): DriftItem[] {
  const items: DriftItem[] = [];
  for (const c of copies) {
    if (roles.get(copyId(c)) === "unowned") items.push({ kind: "unowned", copyId: copyId(c), box: c.box, path: c.path, name: c.name, fix: ["adopt", "remove"] });
  }
  for (const install of installs) {
    const state = states.get(install.id);
    if (!state) continue;
    const base = { installId: install.id, skillId: install.skillId, box: install.box, path: install.path };
    if (state.kind === "missing" || state.kind === "wrong-link" || state.kind === "behind") items.push({ kind: state.kind, ...base, fix: ["apply", "remove"] });
    else if (state.kind === "changed") items.push({ kind: "changed", ...base, changedLines: state.changedLines, fix: ["adopt", "remove"] });
  }
  return items;
}

// Verdicts

export type VerdictInput = {
  skills: readonly SkillRecord[];
  copies: readonly CopyFact[];
  canon: ReadonlyMap<string, CopyFact>;
  texts: ReadonlyMap<string, string>;
  usage: ReadonlyMap<string, FactUse>;
  usageCounted: boolean;
  limits: SkillThresholds;
};

/** Package copies the owner installed stay untouched (c226), so a rule only notes them and never proposes a removal or a merge. */
const isUpstream = (source: SkillSource): boolean => source.kind === "upstream";

/**
 * The rule verdicts of every skill, by skill id. A byte-identical second folder of the same source on the same box is a duplicate to
 * remove, keeping the canonical copy, which matches the owner-approved cleanup of 11-21 (skills review moves.jsonl). The same text under
 * another source, or near-same text over `NEAR_DUPLICATE`, is a merge proposal an agent checks first. A copy behind its source or in an old
 * clone is outdated. A source over the bloat bytes is bloated. A skill no session used in 30 days gets "weak description, review", never a
 * removal, since the owner said on 11-22 a skill may go unused because its description is weak (msg mwqw0mfo).
 */
export function verdicts(input: VerdictInput): Map<string, SkillVerdictRow[]> {
  const out = new Map<string, SkillVerdictRow[]>();
  const add = (skill: string, row: SkillVerdictRow) => out.set(skill, [...(out.get(skill) ?? []), row]);
  const byId = new Map(input.skills.map(s => [s.id, s]));
  const real = input.copies.filter(c => c.linkTarget === null && byId.has(c.key));
  for (const c of input.copies) {
    if (c.linkTarget !== null && !c.exists) {
      const skill = byId.has(c.key) ? c.key : null;
      if (skill) add(skill, { rule: "broken", action: "remove", detail: `The link points at ${c.linkTarget}, which is gone.`, copyId: copyId(c), other: null });
    }
    if (c.deadRefs.length && byId.has(c.key) && input.canon.get(c.key) === c) {
      add(c.key, { rule: "broken", action: "note", detail: `Names ${c.deadRefs.length} missing paths, such as ${c.deadRefs[0]}.`, copyId: copyId(c), other: null });
    }
  }
  for (const skill of input.skills) {
    const canon = input.canon.get(skill.id);
    const copies = real.filter(c => c.key === skill.id);
    for (const c of copies) {
      if (c.stale) {
        const behind = c.checkout?.behind ? `, ${c.checkout.behind} commits behind its upstream` : "";
        add(skill.id, { rule: "stale-clone", action: "note", detail: `Sits in a stale checkout at ${c.checkout?.root ?? c.root}, last commit ${c.checkout?.headAt?.slice(0, 10) ?? "unknown"}${behind}.`, copyId: copyId(c), other: c === canon ? null : canon ? copyId(canon) : null });
      } else if (c !== canon && canon && c.hash && canon.hash && c.hash !== canon.hash) {
        add(skill.id, { rule: "outdated", action: "note", detail: `${c.changedLines ?? "Some"} lines differ from the source ${copyId(canon)}.`, copyId: copyId(c), other: copyId(canon) });
      }
    }
    if (canon && !isUpstream(skill.source)) {
      const twins = copies.filter(c => c !== canon && c.box === canon.box && c.hash === canon.hash && !c.stale && c.checkout?.root === canon.checkout?.root && !RUNTIME_COPY.test(c.path) && !PIHOST_COPY.test(c.path));
      for (const twin of twins) add(skill.id, { rule: "duplicate", action: "remove", detail: `A byte-identical second folder of ${skill.name} on ${twin.box}; ${copyId(canon)} stays.`, copyId: copyId(twin), other: copyId(canon) });
    }
    if (isUpstream(skill.source) && canon) {
      const twins = copies.filter(c => c !== canon && c.box === canon.box && c.hash === canon.hash && skill.source.kind === "upstream" && skill.source.package === "claude.ai");
      for (const twin of twins) add(skill.id, { rule: "duplicate", action: "remove", detail: `The same claude.ai skill in a second sync folder; ${copyId(canon)} stays.`, copyId: copyId(twin), other: copyId(canon) });
    }
    if (canon?.bytes != null && canon.bytes > input.limits.bloatBytes && !isUpstream(skill.source)) {
      const ratio = input.limits.medianBytes ? canon.bytes / input.limits.medianBytes : 0;
      add(skill.id, { rule: "bloated", action: "note", detail: `${canon.bytes.toLocaleString("en-US")} bytes, ${ratio.toFixed(1)}x the median of our skills (${input.limits.medianBytes.toLocaleString("en-US")} bytes).`, copyId: copyId(canon), other: null });
    }
    const use = input.usage.get(skill.name);
    if (input.usageCounted && !(use && use.uses30d > 0) && skill.source.kind !== "harness") {
      add(skill.id, isUpstream(skill.source)
        ? { rule: "unused", action: "note", detail: "No session opened or called it in 30 days.", copyId: null, other: null }
        : { rule: "unused", action: "review-description", detail: "No session opened or called it in 30 days; its description may be too weak for agents to pick it, so review it before any removal.", copyId: null, other: null });
    }
  }
  const canons = input.skills.flatMap(s => {
    const c = input.canon.get(s.id);
    const text = c ? input.texts.get(c.hash ?? "") : undefined;
    return c && text !== undefined && c.hash ? [{ skill: s, copy: c, text, lines: lineSet(text) }] : [];
  });
  for (let i = 0; i < canons.length; i++) {
    for (let j = i + 1; j < canons.length; j++) {
      const a = canons[i]!;
      const b = canons[j]!;
      const sameName = a.skill.name === b.skill.name;
      const same = a.copy.hash === b.copy.hash;
      if (!same && !sameName && lineOverlap(a.lines, b.lines) < input.limits.nearDuplicate) continue;
      const score = same ? 1 : similarity(a.text, b.text);
      const pair = [[a, b], [b, a]] as const;
      if (score >= input.limits.nearDuplicate) {
        const [keep, extra] = keepFirst(a, b);
        const action = isUpstream(extra.skill.source) || isUpstream(keep.skill.source) ? "note" : "merge";
        const rule = same ? "duplicate" : "near-duplicate";
        const detail = same ? `The same text as ${keep.skill.id}.` : `${Math.round(score * 100)}% of its lines match ${keep.skill.id}.`;
        add(extra.skill.id, { rule, action, detail: action === "merge" ? `${detail} An agent checks the merge before it applies.` : detail, copyId: copyId(extra.copy), other: keep.skill.id });
        add(keep.skill.id, { rule, action: "note", detail: `${extra.skill.id} ${same ? "holds the same text" : `matches ${Math.round(score * 100)}% of its lines`}.`, copyId: null, other: extra.skill.id });
      } else if (sameName) {
        for (const [x, y] of pair) add(x.skill.id, { rule: "name-clash", action: "note", detail: `${y.skill.id} has the same name and different text (${Math.round(score * 100)}% of lines match).`, copyId: null, other: y.skill.id });
      }
    }
  }
  return out;
}

/** Of two near-duplicates, the one to keep: ours over a package's, a git source over a loose folder, a fresh checkout, then the shorter path. */
function keepFirst<T extends { skill: SkillRecord; copy: CopyFact }>(a: T, b: T): [T, T] {
  const rank = (x: T) => [isUpstream(x.skill.source) ? 0 : 1, x.skill.source.kind === "git" ? 1 : 0, x.copy.stale ? 0 : 1, -x.copy.path.length];
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]! ? [a, b] : [b, a];
  return a.skill.id < b.skill.id ? [a, b] : [b, a];
}

// Who sees a skill

const SW_KINDS: readonly ThreadKind[] = ["sw-comm", "sw-work", "sw-job", "sw-subagent", "sw-duty"];
const PRIME_KINDS: readonly ThreadKind[] = ["prime-chat", "prime-job", "prime-subagent", "prime-duty"];
/** Prime drops `refine` below depth 0, while pi-host passes it at every depth (skills-load findings, agent-session.js:8900). */
const ROOT_ONLY = new Set(["refine"]);

/** Whether Prime's `skills` setting turns this folder off, such as `-../../.agents/skills/find-skills` or `-prime-intellect/SKILL.md`. */
function primeExcluded(copy: CopyFact, settings: BoxSettings | null): boolean {
  const dir = basename(copy.path);
  return (settings?.primeSkills ?? []).some(entry => {
    if (!entry.startsWith("-") && !entry.startsWith("!")) return false;
    const parts = entry.slice(1).replace(/\/SKILL\.md$/, "").split("/").filter(p => p && p !== ".." && p !== ".");
    return parts.at(-1) === dir || parts.at(-1) === "**";
  });
}

/** The repo whose own settings hide its `.agents/skills` from Prime, as auto-sns-agent's `!../../.agents/skills/**` does. */
function repoHides(copy: CopyFact, settings: BoxSettings | null): boolean {
  const repo = copy.checkout?.root;
  if (!repo) return false;
  return (settings?.repos[repo] ?? []).some(entry => (entry.startsWith("!") || entry.startsWith("-")) && entry.includes(".agents/skills"));
}

/**
 * How each thread kind sees a skill, from the copies on the box the threads run on: the folders each runtime reads (Prime and pi-host read
 * ~/.prime/agent/skills, ~/.agents/skills, the bundled release and a repo's .agents/skills when the cwd is that repo; Claude Code reads
 * ~/.claude/skills, enabled plugins and a repo's .claude/skills; Codex reads ~/.codex/skills, ~/.agents/skills and a repo's .agents/skills),
 * then the filters: disable-model-invocation, Prime's `skills` and `bundledSkills` settings, a repo's own Prime settings and Prime's depth
 * rule for refine (~/work/skills-tab/skills-load/findings.md). `inlined` names the skill pi-host puts in full in every sw factory thread.
 */
export function sees(name: string, copies: readonly CopyFact[], settings: BoxSettings | null, inlined: string | null = null): SkillSight[] {
  const out = new Map<ThreadKind, SkillSight>();
  const hidden = new Map<ThreadKind, string>();
  const give = (kind: ThreadKind, sight: SkillSight) => {
    const cur = out.get(kind);
    if (cur?.how === "inlined") return;
    if (!cur || cur.how === "cwd" || (cur.how === "listed" && sight.how === "imported")) out.set(kind, sight);
  };
  for (const c of copies) {
    if (!c.exists) continue;
    const id = copyId(c);
    const root = c.root;
    const inPrime = c.source === "prime-links" || c.source === "prime-release" || (c.source === "user-dir" && root.endsWith("/.agents/skills"));
    if (inPrime) {
      const why = c.dmi ? "disable-model-invocation hides it from the skill list"
        : c.source === "prime-release" && settings?.primeBundledSkills[c.name] === false ? "Prime's bundledSkills setting turns the bundled copy off"
          : primeExcluded(c, settings) ? "Prime's skills setting turns it off" : null;
      for (const kind of [...SW_KINDS, ...PRIME_KINDS]) {
        if (why) hidden.set(kind, why);
        else if (ROOT_ONLY.has(name) && (kind === "prime-job" || kind === "prime-subagent")) hidden.set(kind, "Prime lists it only at depth 0");
        else if (inlined === name && SW_KINDS.includes(kind)) out.set(kind, { kind, how: "inlined", copyId: id });
        else give(kind, { kind, how: c.pythonImport ? "imported" : "listed", copyId: id });
      }
    }
    if (root.endsWith("/.claude/skills") || /\/\.claude\/skills\//.test(c.path) && !c.checkout) give("claude", { kind: "claude", how: "listed", copyId: id });
    if (c.source === "claude-plugin") {
      const m = PLUGIN.exec(c.realPath);
      if (m && settings?.claudeEnabledPlugins[`${m[3]}@${m[2]}`]) give("claude", { kind: "claude", how: "listed", copyId: id });
      else hidden.set("claude", "its Claude Code plugin is off");
    }
    if (root.endsWith("/.codex/skills") || (c.source === "user-dir" && root.endsWith("/.agents/skills"))) give("codex", { kind: "codex", how: "listed", copyId: id });
    if (c.source.startsWith("repo:") && c.checkout) {
      const repo = basename(c.checkout.root);
      if (root.includes("/.agents/skills")) {
        give("codex", { kind: "codex", how: "cwd", repo, copyId: id });
        if (repoHides(c, settings)) for (const kind of [...SW_KINDS, ...PRIME_KINDS]) hidden.set(kind, `${repo}'s .prime/agent/settings.json hides its .agents/skills`);
        else if (!c.dmi) for (const kind of [...SW_KINDS, ...PRIME_KINDS]) give(kind, { kind, how: "cwd", repo, copyId: id });
      }
      if (root.includes("/.claude/skills")) give("claude", { kind: "claude", how: "cwd", repo, copyId: id });
      if (root.includes("/.codex/skills")) give("codex", { kind: "codex", how: "cwd", repo, copyId: id });
    }
  }
  return THREAD_KINDS.map(kind => out.get(kind) ?? { kind, how: "hidden", why: hidden.get(kind) ?? "no folder this kind reads holds it" });
}

// The folder tree

/** Each box's scanned roots as a tree of folders under the home folder, with the copies and links under each. */
export function tree(copies: readonly CopyFact[]): SkillTreeNode[] {
  type Node = { name: string; path: string; copies: number; links: number; loadedBy: Set<SkillRuntime>; children: Map<string, Node> };
  const top: Node = { name: "", path: "", copies: 0, links: 0, loadedBy: new Set(), children: new Map() };
  for (const c of copies) {
    const parts = c.root.split("/").filter(Boolean);
    let node = top;
    let path = "";
    for (const part of parts) {
      path += `/${part}`;
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = { name: part, path, copies: 0, links: 0, loadedBy: new Set(), children: new Map() }));
      node = child;
      if (c.linkTarget === null) node.copies++;
      else node.links++;
      for (const r of c.runtimes) node.loadedBy.add(r);
    }
  }
  const fold = (node: Node): SkillTreeNode => {
    let at = node;
    let name = node.name;
    while (at.children.size === 1) {
      const only = [...at.children.values()][0]!;
      if (only.copies !== at.copies || only.links !== at.links) break;
      at = only;
      name = `${name}/${only.name}`;
    }
    return { name, path: at.path, copies: node.copies, links: node.links, loadedBy: [...node.loadedBy].sort(), children: [...at.children.values()].map(fold).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  return [...top.children.values()].map(fold);
}

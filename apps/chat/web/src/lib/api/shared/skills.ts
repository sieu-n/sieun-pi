/**
 * The skills inventory that sieun-pi's scripts/skills-inventory.py writes to ~/work/skills-health/inventory.json, as the Skills section of
 * Settings' `current` layout reads it through GET /api/skills/inventory (server/skills.ts). The scanner owns the shape; `parseInventory` keeps the rows it can read and
 * fills a missing field with its empty value, so a scanner that adds a field or skips one never blanks the page.
 */

export const SKILL_KINDS = ["ours", "fork", "upstream", "pointer", "rule", "harness"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export type SkillVerdict = "keep" | "merge" | "remove";
export type SkillFlagKind = "duplicate" | "drift" | "pointer" | "unrequested" | "unused" | "broken";

export type SkillFlag = { kind: SkillFlagKind | (string & {}); detail: string };

/** One use of a skill in a transcript. A pi-host use names its thread, conversation and entry, so it links into sw factory. */
export type SkillUse = {
  at: string;
  session: string;
  agent: string | null;
  how: string;
  runtime: string | null;
  box: string | null;
  conversation: number | null;
  entry: number | null;
};

export type SkillRow = {
  id: string;
  name: string;
  kind: SkillKind | "other";
  group: string | null;
  description: string;
  box: string;
  path: string;
  links: string[];
  runtimes: string[];
  upstream: { url: string; status: "same" | "drift" | "unknown" } | null;
  duplicateOf: string[];
  flags: SkillFlag[];
  useful: { verdict: SkillVerdict | null; reason: string; mergeInto: string | null };
  /** The agents that load it, the sessions that read or called it in the last 7 and 30 days, and how it gets loaded. */
  loadedBy: { agents: string[]; agentsCount: number; sessions7d: number | null; sessions30d: number | null; how: string[] };
  uses7d: number | null;
  uses30d: number | null;
  uses: SkillUse[];
  lastChange: { sha: string; at: string; subject: string } | null;
};

export type SkillBox = { box: string; scannedAt: string | null; ok: boolean; error: string | null };

export type SkillInventory = { generatedAt: string | null; definition: string | null; boxes: SkillBox[]; skills: SkillRow[] };

/** The scanner's last or running scan, which POST /api/skills/scan starts and the `skills` live event sends as it starts and ends. */
export type SkillScan = { running: boolean; startedAt: number | null; endedAt: number | null; error: string | null };

/** What GET /api/skills/inventory answers for the `current` layout: the last inventory read, and the last or running scan. */
export type SkillsReport = {
  inventory: SkillInventory | null;
  /** Why the inventory file did not read, such as "no inventory yet"; null when it read. */
  readError: string | null;
  scan: SkillScan;
};

/**
 * GET /api/skills/doc?id=: one row with its SKILL.md (or rule file) as text, or why the text did not read, and the rows its duplicate and
 * merge fields name, for their names and boxes.
 */
export type SkillDoc = { row: SkillRow; text: string | null; textError: string | null; related: SkillRow[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : []);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

const isKind = (value: unknown): value is SkillKind => (SKILL_KINDS as readonly unknown[]).includes(value);
const VERDICTS: readonly SkillVerdict[] = ["keep", "merge", "remove"];
const isVerdict = (value: unknown): value is SkillVerdict => (VERDICTS as readonly unknown[]).includes(value);

function parseUse(raw: Json): SkillUse | null {
  const at = str(raw.at);
  const session = str(raw.session);
  if (!at || !session) return null;
  return {
    at, session, agent: str(raw.agent), how: str(raw.how) ?? "use", runtime: str(raw.runtime), box: str(raw.box),
    conversation: num(raw.conversation), entry: num(raw.entry),
  };
}

function parseRow(raw: Json): SkillRow | null {
  const name = str(raw.name);
  const box = str(raw.box) ?? "";
  const path = str(raw.path) ?? "";
  const id = str(raw.id) ?? (name ? `${box}:${path || name}` : null);
  if (!name || !id) return null;
  const useful = isObject(raw.useful) ? raw.useful : {};
  const loadedBy = isObject(raw.loadedBy) ? raw.loadedBy : {};
  const upstream = isObject(raw.upstream) && str(raw.upstream.url) ? raw.upstream : null;
  const status = upstream?.status;
  const change = isObject(raw.lastChange) && str(raw.lastChange.sha) ? raw.lastChange : null;
  return {
    id, name, box, path,
    kind: isKind(raw.kind) ? raw.kind : "other",
    group: str(raw.group),
    description: str(raw.description) ?? "",
    links: strings(raw.links),
    runtimes: strings(raw.runtimes),
    upstream: upstream ? { url: String(upstream.url), status: status === "same" || status === "drift" ? status : "unknown" } : null,
    duplicateOf: strings(raw.duplicateOf),
    flags: objects(raw.flags).flatMap(flag => (str(flag.kind) ? [{ kind: String(flag.kind), detail: str(flag.detail) ?? "" }] : [])),
    useful: { verdict: isVerdict(useful.verdict) ? useful.verdict : null, reason: str(useful.reason) ?? "", mergeInto: str(useful.mergeInto) },
    loadedBy: {
      agents: strings(loadedBy.agents), agentsCount: num(loadedBy.agentsCount) ?? strings(loadedBy.agents).length, how: strings(loadedBy.how),
      sessions7d: num(loadedBy.sessions7d) ?? num(raw.sessions7d), sessions30d: num(loadedBy.sessions30d) ?? num(raw.sessions30d),
    },
    uses7d: num(raw.uses7d),
    uses30d: num(raw.uses30d),
    uses: objects(raw.uses).flatMap(use => parseUse(use) ?? []).sort((a, b) => b.at.localeCompare(a.at)),
    lastChange: change ? { sha: String(change.sha), at: str(change.at) ?? "", subject: str(change.subject) ?? "" } : null,
  };
}

/** The inventory file's JSON as rows, or null when it is not an inventory at all. */
export function parseInventory(raw: unknown): SkillInventory | null {
  if (!isObject(raw) || !Array.isArray(raw.skills)) return null;
  return {
    generatedAt: str(raw.generatedAt),
    definition: str(raw.definition),
    boxes: objects(raw.boxes).flatMap(b => (str(b.box) ? [{ box: String(b.box), scannedAt: str(b.scannedAt), ok: b.ok !== false, error: str(b.error) }] : [])),
    skills: objects(raw.skills).flatMap(row => parseRow(row) ?? []),
  };
}

/** The sw factory conversation a pi-host use happened in: the thread for its first conversation, else `<thread>:<conversation>`. */
export function useConversation(use: SkillUse): string | null {
  if (use.runtime !== null && use.runtime !== "pi-host") return null;
  if (use.conversation === null || use.entry === null) return null;
  return use.conversation === 1 ? use.session : `${use.session}:${use.conversation}`;
}

/*
 * The skills DB read model. sw factory keeps the wanted state of every skill in <data dir>/chat.sqlite (server/skills-db.ts): one row per
 * skill with its owner, its one source and its installs. Each scan of scripts/skills-inventory.py adds the copies it saw on disk, and rules
 * give every skill its verdicts. GET /api/skills answers one `SkillsView` that a Settings > Skills layout renders whole, and the `sw skills`
 * commands (apps/chat/bin/sw.mjs) call the same routes. The owner asked for it in #sw-factory-build on 11-22 (msgs mwqwfx5h, mwqwgfsi):
 * "DB에 저장되어있고 ... should be checkable/installable by command & api call" and "so idempotent, db owns ownership".
 */

/** A box the scanner reads: us-metal02 itself, or the Mac over ssh. */
export type BoxName = string;

/** The tools that load skills from disk. pi-host reads Prime's folders, so a Prime install reaches pi-host too. */
export const SKILL_RUNTIMES = ["prime", "pi-host", "claude", "codex", "pi"] as const;
export type SkillRuntime = (typeof SKILL_RUNTIMES)[number];

/** Who answers for a skill: the owner, or an agent by its id, such as ag_agent-factory. */
export type SkillOwner = { kind: "owner" } | { kind: "agent"; id: string };

/**
 * Where a skill's text lives. A git source names its repo and the folder in it, such as sieun-pi `skills/board`. An upstream source is a
 * package the owner installed and keeps untouched (c226), such as a Claude Code plugin or Prime's bundled skills. A harness source is an
 * entry in Prime's global continual harness. A local source is a folder on one box that no git repo or package holds.
 */
export type SkillSource =
  | { kind: "git"; repo: string; path: string }
  | { kind: "upstream"; package: string; url: string | null }
  | { kind: "harness"; entryKind: string; entryId: string }
  | { kind: "local"; box: BoxName; path: string };

/**
 * An install the DB wants on disk: a link to the source, or a copy of it, at `path` on `box`, for the runtimes that read that folder.
 * `agent` names the agent the install is for, where one asked for it; pi-host has no per-agent skill folder, so it is a record only.
 */
export type SkillInstall = {
  id: string;
  box: BoxName;
  path: string;
  mode: "link" | "copy";
  runtimes: SkillRuntime[];
  agent: string | null;
  state: InstallState;
};

/**
 * How an install matches the disk at the last scan. `changed` is a copy edited in place since it was placed; `behind` is a copy whose
 * source moved on since, which `sw skills apply` refreshes; `unknown` is an install on a box whose last scan failed.
 */
export type InstallState =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "wrong-link"; target: string | null }
  | { kind: "changed"; changedLines: number }
  | { kind: "behind"; changedLines: number }
  | { kind: "unknown"; reason: string };

/**
 * What one folder on disk is to its skill. `source` is the git folder or package folder that holds the text, `checkout` another checkout
 * of the same git source (the Mac's sieun-pi, an old clone), `install` a link or copy an install row names, and `unowned` a folder the DB
 * has no row for, which `sw skills check` lists until someone adopts or removes it.
 */
export type CopyRole = "source" | "checkout" | "install" | "unowned";

/** One folder or link the last scan of its box saw. */
export type SkillCopy = {
  /** `<box>:<path>`, the id `sw skills remove` and `adopt` take. */
  id: string;
  box: BoxName;
  path: string;
  role: CopyRole;
  installId: string | null;
  /** Where a symlink points as readlink gives it, else null. */
  link: string | null;
  /** The folder the path resolves to, through every link on the way, such as a release folder behind `current`. */
  realPath: string;
  /** False for a link whose target is gone. */
  exists: boolean;
  hash: string | null;
  lines: number | null;
  /** The SKILL.md's own bytes, which the bloat rule measures; `folderBytes` counts the whole folder with its scripts and references. */
  bytes: number | null;
  folderBytes: number | null;
  files: number | null;
  mtime: string | null;
  /** The tools that read the folder this copy sits in. */
  loadedBy: SkillRuntime[];
  /** Lines added plus lines removed against the source text; 0 when identical, null when either text did not read. */
  changedLines: number | null;
  /** The git checkout this copy sits in, with its last commit time; `stale` when that commit is older than `STALE_CHECKOUT_DAYS`. */
  checkout: { root: string; branch: string | null; headAt: string | null; stale: boolean } | null;
};

/**
 * The rule verdicts, recomputed on every scan (server/skills-rules.ts). Only `merge` needs an agent, which checks the proposal before it
 * applies, and nothing here removes a skill by itself: removal happens when a person or an agent calls remove.
 */
export const VERDICT_RULES = ["duplicate", "near-duplicate", "upstream-match", "name-clash", "outdated", "stale-clone", "bloated", "unused", "broken"] as const;
export type VerdictRule = (typeof VERDICT_RULES)[number];

/** What a verdict proposes: remove a copy, merge it into another skill, review its description, or nothing but a note. */
export type VerdictAction = "remove" | "merge" | "review-description" | "note";

export type SkillVerdictRow = {
  rule: VerdictRule;
  action: VerdictAction;
  detail: string;
  /** The copy the verdict is about, or null when it is about the skill. */
  copyId: string | null;
  /** The skill or copy a duplicate or merge points at. */
  other: string | null;
};

/** The thread kinds whose prompt can list a skill. */
export const THREAD_KINDS = [
  "sw-comm", "sw-work", "sw-job", "sw-subagent", "sw-duty", "prime-chat", "prime-job", "prime-subagent", "prime-duty", "claude", "codex",
] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * How one thread kind sees a skill. `listed` puts its name and description in the prompt, `imported` lists it and pre-imports its Python
 * module, `inlined` puts its whole SKILL.md in the prompt (pi-host's `writing` section, named by WRITING_SKILL in the installed release's
 * prime-prompt.ts), `hidden` keeps it out (with `why`, such as disable-model-invocation), and `cwd` lists it only when the thread's folder is `repo`.
 */
export type SkillSight =
  | { kind: ThreadKind; how: "listed" | "imported"; copyId: string }
  | { kind: ThreadKind; how: "inlined"; copyId: string }
  | { kind: ThreadKind; how: "cwd"; repo: string; copyId: string }
  | { kind: ThreadKind; how: "hidden"; why: string };

/** Use in the last 30 days: tool calls that opened the SKILL.md or called its module, the sessions they came from, and the last one. */
export type SkillUse30d = {
  uses: number;
  sessions: number;
  lastUse: string | null;
  byKind: Partial<Record<ThreadKind, { uses: number; sessions: number }>>;
};

export type SkillEntry = {
  /** Stable id: the source key plus the name, such as `git:sieun-pi/skills/board`. */
  id: string;
  name: string;
  description: string;
  owner: SkillOwner;
  source: SkillSource;
  installs: SkillInstall[];
  copies: SkillCopy[];
  /** The source text's size against the median of our skills; `ratio` is bytes over the median bytes. */
  size: { lines: number | null; bytes: number | null; ratio: number | null };
  verdicts: SkillVerdictRow[];
  use: SkillUse30d;
  /** Whether a Python module of this name is pre-imported in Prime and pi-host, which counts every call as a use. */
  preimported: boolean;
  sees: SkillSight[];
  /**
   * Each real folder of this skill beyond the one that stays on its box: `same-text` is a duplicate to remove, `other-text` differs from the
   * kept folder, and `stale-clone` sits in an old checkout. Links, release folders and one folder per box are never extra. Layouts show this
   * list and its length, so the extra-copy number matches the copies column.
   */
  extraCopies: { copyId: string; keptId: string; why: "same-text" | "other-text" | "stale-clone" }[];
};

/** A folder in a box's tree, with the skill folders under it. */
export type SkillTreeNode = { name: string; path: string; copies: number; links: number; loadedBy: SkillRuntime[]; children: SkillTreeNode[] };

/**
 * A box's scan state. An asleep Mac keeps its last good scan: `state` is `offline`, `since` is the first failed scan after it, and
 * the page words it in the viewer's own time (web/src/pages/skills/box-line.ts); `error` holds the raw ssh error for a hover.
 */
export type SkillBoxState = {
  box: BoxName;
  state: "ok" | "offline" | "never";
  scannedAt: string | null;
  lastOkAt: string | null;
  since: string | null;
  seconds: number | null;
  error: string | null;
  tree: SkillTreeNode[];
};

/** The numbers the rules use, each with where it came from. */
export type SkillThresholds = {
  medianBytes: number;
  medianLines: number;
  bloatBytes: number;
  nearDuplicate: number;
  staleCheckoutDays: number;
  source: string;
};

/**
 * Which verdict rules each headline count and layout group takes: a skill counts in a group when any of its verdicts has one of the rules,
 * however many of its copies match. name-clash and broken are groups of their own with no headline count.
 */
export const COUNT_RULES = {
  duplicated: ["duplicate", "near-duplicate"],
  outdated: ["outdated", "stale-clone"],
  bloated: ["bloated"],
} as const satisfies Record<string, readonly VerdictRule[]>;

/** The headline counts over every skill. A skill counts once per rule however many of its copies match. */
export type SkillCounts = {
  skills: number;
  copies: number;
  installs: number;
  duplicated: number;
  outdated: number;
  bloated: number;
  neverUsed: number;
  drift: number;
};

/** GET /api/skills: everything a layout needs, in one call. */
export type SkillsView = {
  generatedAt: string | null;
  seededAt: string | null;
  counts: SkillCounts;
  thresholds: SkillThresholds;
  boxes: SkillBoxState[];
  skills: SkillEntry[];
  /** Folders whose source has no row yet, and links no install names; `sw skills adopt` or `remove` settles each. */
  unowned: SkillCopy[];
  scan: SkillScan;
};

/**
 * One way the disk differs from the DB, which GET /api/skills/check lists. `unowned` is a folder with no row, `missing` an install not on
 * disk, `changed` a copy edited in place, `behind` a copy whose source moved on, and `wrong-link` a link that points elsewhere. Each item
 * names the commands that settle it.
 */
export type DriftItem =
  | { kind: "unowned"; copyId: string; box: BoxName; path: string; name: string; fix: ("adopt" | "remove")[] }
  | { kind: "missing" | "wrong-link" | "behind"; installId: string; skillId: string; box: BoxName; path: string; fix: ("apply" | "remove")[] }
  | { kind: "changed"; installId: string; skillId: string; box: BoxName; path: string; changedLines: number; fix: ("adopt" | "remove")[] };

export type SkillsCheck = { at: string; items: DriftItem[]; offline: BoxName[] };

/** One disk step a change took or `sw skills apply` would take, and how it went; `installId` is empty for a step no install names. */
export type ApplyStep = {
  installId: string;
  box: BoxName;
  path: string;
  step: "create" | "relink" | "refresh" | "delete" | "fold" | "restore";
  result: "done" | "planned" | "queued" | "failed";
  note: string | null;
};

/** POST /api/skills/apply, with `{ dryRun: true }` to plan only. `changes` counts the steps that did or would change the disk. */
export type ApplyResult = { at: string; dryRun: boolean; changes: number; steps: ApplyStep[]; moveId: string | null };

/** A logged change: what the DB and disk looked like before, so `sw skills undo <id>` puts it back. */
export type SkillMove = {
  id: string;
  at: string;
  kind: "install" | "remove" | "adopt" | "move" | "merge" | "apply" | "own";
  summary: string;
  undoneAt: string | null;
};

export type InstallBody = { name: string; box: BoxName; runtime: SkillRuntime; agent?: string | null; mode?: "link" | "copy"; path?: string | null; source?: string | null };
/** `target` is a copy id (`<box>:<path>`), an install id, or a skill id. */
export type RemoveBody = { target: string };
export type AdoptBody = { copyId: string; skillId?: string | null };
export type MoveBody = { installId: string; path: string };
export type UndoBody = { moveId: string };
export type OwnBody = { skillId: string; owner: string };
/** Hands agent factory's work thread a merge of `skillId` into `into`: it checks the proposal, moves the lines `into` lacks, then removes `skillId`. */
export type MergeBody = { skillId: string; into: string };
export type ApplyBody = { dryRun?: boolean };

/**
 * What every change answers: its logged move, which `sw skills undo <move id>` reverses, and the disk steps it took. A step on a box that
 * is asleep waits in the Mac queue and reads `queued`.
 */
export type SkillsChange = { move: SkillMove; apply: ApplyResult | null };

/** GET /api/skills/moves: the newest changes first. */
export type SkillMoves = { moves: SkillMove[] };

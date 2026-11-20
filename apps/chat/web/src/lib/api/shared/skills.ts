/**
 * The skills inventory that sieun-pi's scripts/skills-inventory.py writes to ~/work/skills-health/inventory.json, as the Skills section of
 * Settings reads it through GET /api/skills (server/skills.ts). The scanner owns the shape; `parseInventory` keeps the rows it can read and
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

/** What GET /api/skills answers: the last inventory read, and the last or running scan. */
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

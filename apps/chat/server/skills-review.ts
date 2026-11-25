/**
 * Skills review: the cleanup proposals from the skills inventory (server/skills.ts), one item per screen, for the review route at
 * #/settings/skills/review. The owner asked for it on For you todo t4 (msg mwqukzwx): "하나씩 리뷰할 수 있게 mini webapp 만들어주라". The shapes
 * live in web/src/lib/api/shared/skills-review.ts.
 *
 * An item is one skill name, or one plugin for Claude Code and Codex plugin skills, with every copy of it on every box. It exists when one
 * of its copies has the verdict remove or merge. Approve carries out each copy's action from where the copy lives (`ReviewHow`): `trash`
 * moves the folder into the set's trash, `git` removes it from its checkout with a commit of only that path and pushes, `harness` deletes the
 * entry from its store under pi-harness's lock, and `fold-job` hands the fold to agent factory's work thread. A Mac copy waits in the set's
 * Mac queue and runs over ssh. Every step writes one line to `<state dir>/moves.jsonl` and keeps a backup, which Undo restores from.
 * Approve and Undo converge: a second click finds each copy where the first left it and does nothing more.
 *
 * A set is one inventory plus the folder that holds its decisions (`state.json`), Mac queue, backups and log. `live` reads the real
 * inventory with ~/work/skills-review; any other set is registered as `<review dir>/sets/<name>.json` and may only touch paths under its root.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { NotFound } from "./app.ts";
import type { DiskResult, DiskStep, DiskSteps } from "./skills-db.ts";
import { Skills } from "./skills.ts";
import { writeFixtureSet } from "./skills-review-fixture.ts";
import { globalHarnessDir, KINDS, readState, updateState, type HarnessEntry, type Kind } from "../../../packages/pi-harness/src/core/store.ts";
import {
  REVIEW_ACTIONS, type CopyState, type ItemStatus, type ReviewAction, type ReviewCopy, type ReviewDecideBody, type ReviewDecision, type ReviewEvent,
  type ReviewHow, type ReviewItem, type ReviewItemSummary, type ReviewReport, type ReviewResult, type ReviewUndoBody,
} from "../web/src/lib/api/shared/skills-review.ts";

const run = promisify(execFile);

export type SkillsReviewConfig = {
  /** Where the live set keeps its state and where `sets/<name>.json` registers the others: `APPS_CHAT_SKILLS_REVIEW_DIR`, else ~/work/skills-review. */
  dir: string;
  /** On the fixture server, the default set is `fixture`, built under `dir` on first use, and no `live` set exists. */
  fixture: boolean;
  /** The ssh host of the Mac for the live set, `mac` as scripts/skills-inventory.py's --mac-host default. */
  macHost: string | null;
};

/** A caller's mistake, such as an unknown copy id or a bad action; http.ts answers it 400. */
export class ReviewRefused extends Error {}

type ReviewSet = {
  name: string;
  live: boolean;
  inventory: string;
  stateDir: string;
  /** Every path an action touches sits under it; null only for `live`. */
  root: string | null;
  macHost: string | null;
  /** The harness store folder that holds `harness_state.json` for rows loaded from Prime's global harness. */
  harnessStore: string;
  /** The box whose rows are files here. */
  box: string;
  /** Where Mac backups go on the Mac; `~/` means its home. */
  macTrash: string;
};

/** One inventory row as the review reads it, also kept in each step it took so Undo works after a rescan drops the row. */
type Row = {
  id: string; name: string; box: string; path: string; dir: string; family: string; kind: string; group: string | null; description: string;
  sizeBytes: number | null; lines: number | null; files: number | null; lastUse: string | null; uses30d: number | null;
  lastChange: { sha: string; at: string; subject: string } | null; verdict: string | null; reason: string; mergeInto: string | null;
  actionable: boolean; text: string | null; entryId: string | null; globalStore: boolean;
  item: string; title: string; unit: "skill" | "plugin";
};

/** How a step runs: a review's ways, plus `place`, which makes a link or copy for the skills DB (server/skills-db.ts). */
type OpHow = ReviewHow | "place";

/** One copy's step: what Approve did to it, enough to undo it with no inventory row. */
type Op = {
  row: Row; how: OpHow; action: ReviewAction; place?: { mode: "link" | "copy"; from: string }; foldInto: string | null; state: CopyState; note: string | null; at: string;
  backup: string | null; repo: string | null; rel: string | null; commit: string | null;
  /** A skills DB delete, whose goal is that nothing sits at the path, so a path already gone ends the step as done. */
  absentOk?: boolean;
};

type ItemRecord = { status: ItemStatus; decision: ReviewDecision | null; stamp: string | null; ops: Record<string, Op> };
type SetState = { items: Record<string, ItemRecord> };
type MacStep = { item: string; copy: string; kind: "apply" | "undo"; dir: string; backup: string; at: string; place?: { mode: "link" | "copy"; from: string }; absentOk?: boolean };
type MacQueue = { queue: MacStep[]; online: boolean | null; checkedAt: string | null };

type Loaded = { set: ReviewSet; skills: Skills };
type Hooks = {
  log: (line: string) => void;
  broadcast: (event: ReviewEvent) => void;
  /** Submits a brief to agent factory's work thread, for the live set's folds. */
  fold: (text: string, requestId: string) => Promise<void>;
};

const PLUGIN_FAMILIES = new Set(["claude-plugin", "codex-plugin"]);
const PLUGIN_GROUPS = new Set(["Claude Code plugins", "Codex plugins"]);
const MAC = "mac";
/** The Mac queue's retry gap: the one-minute cadence prime-sync already runs on every box (sieun-pi AGENTS.md). */
const MAC_RETRY_MS = 60_000;
/** ssh options of scripts/skills-inventory.py's scan_remote, so a dead Mac fails in 10 s instead of hanging. */
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
/** A text over this many lines cells (two 5000-line files) diffs as a whole replace: the LCS table takes 4 bytes a cell, so 100 MB. */
const DIFF_CELLS = 25_000_000;

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const now = () => new Date().toISOString();
/** Whether anything sits at `path`, a link whose target is gone included, which existsSync misses. */
const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
/** The items of the skills DB's moves, which the review list leaves out. */
const DB_ITEM = "sw:";
const live = (op: Op | undefined): boolean => op?.state === "applied" || op?.state === "queued";
const message = (error: unknown): string => {
  const e = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  return (stderr || (error instanceof Error ? error.message : String(error))).split("\n").slice(-3).join(" ");
};

/** The item a row belongs to: its plugin for plugin skills, else its name. */
function rowOf(raw: Record<string, unknown>): Row | null {
  const name = str(raw.name);
  const id = str(raw.id);
  const box = str(raw.box);
  if (!name || !id || !box) return null;
  const family = str(raw.family) ?? "";
  const group = str(raw.group);
  const how = (Array.isArray(obj(raw.loadedBy).how) ? (obj(raw.loadedBy).how as unknown[]) : []).map(String);
  const plugin = (PLUGIN_FAMILIES.has(family) || (group !== null && PLUGIN_GROUPS.has(group))) && how[0] ? how[0] : null;
  const useful = obj(raw.useful);
  const uses = Array.isArray(raw.uses) ? (raw.uses as unknown[]).map(use => str(obj(use).at)).filter((at): at is string => at !== null) : [];
  const change = obj(raw.lastChange);
  const path = str(raw.path) ?? "";
  return {
    id, name, box, path, dir: str(raw.dir) ?? path, family, kind: str(raw.kind) ?? "other", group, description: str(raw.description) ?? "",
    sizeBytes: num(raw.sizeBytes), lines: num(raw.lines), files: num(raw.files), lastUse: uses.sort().at(-1) ?? null, uses30d: num(raw.uses30d),
    lastChange: str(change.sha) ? { sha: String(change.sha), at: str(change.at) ?? "", subject: str(change.subject) ?? "" } : null,
    verdict: str(useful.verdict), reason: str(useful.reason) ?? "", mergeInto: str(useful.mergeInto), actionable: useful.action === true,
    text: typeof raw.text === "string" ? raw.text : null, entryId: str(raw.entryId), globalStore: how.some(h => /\(global\)/.test(h)),
    item: plugin ? `plugin:${plugin}` : `skill:${name}`, title: plugin ?? name, unit: plugin ? "plugin" : "skill",
  };
}

/** The scanner's verdict as an action: remove is delete, merge is fold, and anything it marks as needing nothing is keep. */
function proposedOf(row: Row): ReviewAction {
  if (!row.actionable) return "keep";
  return row.verdict === "remove" ? "delete" : row.verdict === "merge" ? "fold" : "keep";
}

const harnessRef = (row: Row): { kind: Kind; id: string } | null => {
  if (!row.dir.startsWith("harness:")) return null;
  const [, kind, ...rest] = row.dir.split(":");
  const id = row.entryId ?? rest.join(":");
  return (KINDS as readonly string[]).includes(kind ?? "") && id ? { kind: kind as Kind, id } : null;
};

/** `path` with its nearest existing folder resolved through symlinks, so a link cannot carry a path out of a set's root. */
function real(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync(head);
  } catch {}
  return join(head, ...tail);
}

const under = (root: string, path: string): boolean => {
  const top = real(root);
  const at = real(path);
  return at === top || at.startsWith(top + sep);
};

/** The checkout that holds `path`, found by its `.git`, or null. */
function checkoutOf(path: string): string | null {
  let at = dirname(resolve(path));
  while (true) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const macPath = (value: string): string => (value.startsWith("~/") ? `"$HOME"/${quote(value.slice(2))}` : quote(value));

/** A unified line diff of `a` against `b` with three lines of context, or "" when they are the same. */
export function unifiedDiff(a: string, b: string, from: string, to: string): string {
  if (a === b) return "";
  const x = a.split("\n");
  const y = b.split("\n");
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const ops: [" " | "-" | "+", string][] = x.slice(0, pre).map(line => [" ", line]);
  const n = xs.length;
  const m = ys.length;
  if (n * m > DIFF_CELLS) {
    ops.push(...xs.map(line => ["-", line] as [" " | "-" | "+", string]), ...ys.map(line => ["+", line] as [" " | "-" | "+", string]));
  } else {
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) lcs[i * width + j] = xs[i] === ys[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) {
        ops.push([" ", xs[i]!]);
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        ops.push(["-", xs[i++]!]);
      } else {
        ops.push(["+", ys[j++]!]);
      }
    }
  }
  ops.push(...x.slice(x.length - suf).map(line => [" ", line] as [" " | "-" | "+", string]));
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let w = 1;
  for (const [mark] of ops) {
    oldNo.push(o);
    newNo.push(w);
    if (mark !== "+") o++;
    if (mark !== "-") w++;
  }
  const changed = ops.flatMap(([mark], index) => (mark === " " ? [] : [index]));
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(ops.length - 1, index + 3);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }
  const out = [`--- ${from}`, `+++ ${to}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter(([mark]) => mark !== "+").length;
    const newCount = slice.filter(([mark]) => mark !== "-").length;
    out.push(`@@ -${oldCount ? oldNo[start] : oldNo[start]! - 1},${oldCount} +${newCount ? newNo[start] : newNo[start]! - 1},${newCount} @@`);
    out.push(...slice.map(([mark, line]) => mark + line));
  }
  return out.join("\n") + "\n";
}

export class SkillsReview {
  private readonly loaded = new Map<string, Loaded>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly gitCache = new Map<string, { repo: string; rel: string } | null>();

  constructor(
    private readonly config: SkillsReviewConfig,
    private readonly liveSkills: Skills,
    private readonly liveBox: string,
    private readonly hooks: Hooks,
  ) {}

  private get defaultSet(): string {
    return this.config.fixture ? "fixture" : "live";
  }

  /** GET /api/skills/review: every item in review order and the Mac queue. */
  async report(name?: string | null): Promise<ReviewReport> {
    const { set, skills } = this.load(name);
    this.kickMac(set);
    const { inventory, raw, error } = await this.rows(skills);
    const state = await this.state(set);
    const items = this.group(raw, state).map(([id, rows]) => this.summary(id, rows, state.items[id]));
    items.sort((a, b) => Number(done(a.status)) - Number(done(b.status)) || b.toAct - a.toAct || a.title.localeCompare(b.title));
    const queue = await this.queue(set);
    if (error && !raw.length) this.hooks.log(`skills review ${set.name}: ${error}`);
    return { set: set.name, sets: this.setNames(), generatedAt: inventory, items, counts: counts(items), mac: { host: set.macHost, online: queue.online, checkedAt: queue.checkedAt, queued: queue.queue.length } };
  }

  /** GET /api/skills/review/item: one item with every copy, its planned or applied step, and diffs against the keeper. */
  async item(name: string | null | undefined, id: string): Promise<ReviewItem> {
    const loaded = this.load(name);
    this.kickMac(loaded.set);
    return this.view(loaded, id);
  }

  /** POST /api/skills/review/decide. Approve converges each copy on its action; keep and skip put back anything applied first. */
  async decide(body: ReviewDecideBody): Promise<ReviewResult> {
    const loaded = this.load(body.set);
    await this.serial(loaded.set, async () => {
      const { rows } = await this.itemRows(loaded, body.id);
      const state = await this.state(loaded.set);
      const record = (state.items[body.id] ??= { status: "pending", decision: null, stamp: null, ops: {} });
      const overrides: ReviewDecision["overrides"] = {};
      for (const [copy, change] of Object.entries(body.overrides ?? {})) {
        const row = rows.find(r => r.id === copy);
        if (!row) throw new ReviewRefused(`No copy ${copy} in ${body.id}.`);
        const foldInto = change.action === "fold" ? str(change.foldInto) ?? row.mergeInto : null;
        if (change.action === "fold" && !foldInto) throw new ReviewRefused(`A fold of ${copy} names its target as foldInto.`);
        overrides[copy] = { action: change.action, foldInto };
      }
      if (body.action === "approve") {
        record.stamp ??= now().replace(/[:.]/g, "-");
        const want = new Map(rows.map(row => [row.id, overrides[row.id] ?? { action: proposedOf(row), foldInto: proposedOf(row) === "fold" ? row.mergeInto : null }]));
        const plans = await this.plan(loaded.set, rows, want, record);
        // Git copies go first, so a Mac copy that follows a checkout can name its commit.
        const order = [...rows].sort((a, b) => Number(plans.get(b.id)?.how === "git") - Number(plans.get(a.id)?.how === "git"));
        for (const row of order) {
          const target = want.get(row.id)!;
          const op = record.ops[row.id];
          const same = live(op) && op!.action === target.action && op!.foldInto === target.foldInto;
          if (same) {
            if (op!.state === "queued") await this.cancelMacStep(loaded.set, body.id, row.id, "undo", op!, "applied");
            continue;
          }
          if (live(op)) await this.reverse(loaded.set, body.id, record, row.id);
          if (target.action === "keep") continue;
          const plan = plans.get(row.id)!;
          const next: Op = { row, how: plan.how, action: target.action, foldInto: target.foldInto, state: "pending", note: null, at: now(), backup: null, repo: plan.repo, rel: plan.rel, commit: null };
          if (plan.how === "follows-git") next.commit = record.ops[plan.follows ?? ""]?.commit ?? null;
          record.ops[row.id] = next;
          await this.apply(loaded.set, body.id, record, next);
          await this.saveState(loaded.set, state);
        }
      } else {
        for (const copy of Object.keys(record.ops)) if (live(record.ops[copy])) await this.reverse(loaded.set, body.id, record, copy);
      }
      record.status = body.action === "approve" ? "approved" : body.action === "keep" ? "kept" : "skipped";
      record.decision = { at: now(), action: body.action, overrides };
      await this.saveState(loaded.set, state);
    });
    this.hooks.broadcast({ type: "skills-review", set: loaded.set.name, id: body.id });
    this.kickMac(loaded.set);
    return this.result(loaded, body.id);
  }

  /** POST /api/skills/review/undo: restores every applied copy of the item from its backup and clears the decision. */
  async undo(body: ReviewUndoBody): Promise<ReviewResult> {
    const loaded = this.load(body.set);
    await this.serial(loaded.set, async () => {
      await this.itemRows(loaded, body.id);
      const state = await this.state(loaded.set);
      const record = state.items[body.id];
      if (!record) return;
      for (const copy of Object.keys(record.ops)) {
        if (live(record.ops[copy])) await this.reverse(loaded.set, body.id, record, copy);
        await this.saveState(loaded.set, state);
      }
      if (record.decision || record.status !== "pending") {
        record.status = "undone";
        record.decision = null;
      }
      await this.saveState(loaded.set, state);
    });
    this.hooks.broadcast({ type: "skills-review", set: loaded.set.name, id: body.id });
    this.kickMac(loaded.set);
    return this.result(loaded, body.id);
  }

  /**
   * The skills DB's disk steps (server/skills-db.ts), run as one item of a set with the review's backups, Mac queue and moves.jsonl log, so
   * removing, placing and merging a skill share one path with the cleanup the owner approves here. The item stays out of the review list.
   */
  diskSteps(setName: string): DiskSteps {
    return { run: (item, steps) => this.runSteps(setName, item, steps), undo: item => this.undoSteps(setName, item) };
  }

  private async runSteps(setName: string, item: string, steps: DiskStep[]): Promise<DiskResult[]> {
    const loaded = this.load(setName);
    const out = await this.serial(loaded.set, async () => {
      const state = await this.state(loaded.set);
      const record = (state.items[item] ??= { status: "approved", decision: { at: now(), action: "approve", overrides: {} }, stamp: now().replace(/[:.]/g, "-"), ops: {} });
      const rows = steps.map((step, index) => stepRow(item, step, index));
      const want = new Map(rows.map((row, i) => [row.id, { action: (steps[i]!.kind === "fold" ? "fold" : "delete") as ReviewAction }]));
      const trash = (step: DiskStep) => step.kind === "delete" && step.trash === true;
      const plans = await this.plan(loaded.set, rows.filter((_, i) => steps[i]!.kind === "delete" && !trash(steps[i]!)), want, record);
      const results: DiskResult[] = [];
      for (const [i, step] of steps.entries()) {
        const row = rows[i]!;
        const plan = plans.get(row.id);
        const how: OpHow = step.kind === "place" ? "place" : step.kind === "fold" ? "fold-job" : trash(step) ? "trash" : plan?.how ?? "trash";
        const op: Op = {
          row, how, action: step.kind === "fold" ? "fold" : "delete", foldInto: step.kind === "fold" ? step.into : null, state: "pending", note: null, at: now(),
          backup: null, repo: plan?.repo ?? null, rel: plan?.rel ?? null, commit: null, ...(step.kind === "place" ? { place: { mode: step.mode, from: step.from } } : {}),
          ...(step.kind === "delete" ? { absentOk: true } : {}),
        };
        if (how === "follows-git") op.commit = record.ops[plan?.follows ?? ""]?.commit ?? null;
        record.ops[row.id] = op;
        await this.apply(loaded.set, item, record, op);
        await this.saveState(loaded.set, state);
        results.push({ box: step.box, path: step.path, state: diskState(op.state), note: op.note });
      }
      return results;
    });
    this.kickMac(loaded.set);
    return out;
  }

  /** Reverses an item's steps, newest first, so a link placed over a removed one goes before the removed one comes back. */
  private async undoSteps(setName: string, item: string): Promise<DiskResult[]> {
    const loaded = this.load(setName);
    const out = await this.serial(loaded.set, async () => {
      const state = await this.state(loaded.set);
      const record = state.items[item];
      if (!record) return [];
      const results: DiskResult[] = [];
      for (const copy of Object.keys(record.ops).reverse()) {
        const op = record.ops[copy]!;
        if (live(op)) await this.reverse(loaded.set, item, record, copy);
        else if (op.state === "pending" || (op.state === "failed" && !op.note?.startsWith("Undo failed"))) {
          op.state = "undone";
          op.note = "The step never took effect, so nothing was put back.";
        }
        await this.saveState(loaded.set, state);
        results.push({ box: op.row.box, path: op.row.dir, state: diskState(op.state), note: op.note });
      }
      record.status = "undone";
      await this.saveState(loaded.set, state);
      return results;
    });
    this.kickMac(loaded.set);
    return out;
  }

  /** Stops the Mac queue's timers, for a test server's close. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async result(loaded: Loaded, id: string): Promise<ReviewResult> {
    const item = await this.view(loaded, id);
    const report = await this.report(loaded.set.name);
    return { item, counts: report.counts };
  }

  // Sets

  private setNames(): string[] {
    let files: string[] = [];
    try {
      files = readdirSync(join(this.config.dir, "sets")).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
    } catch {}
    return [...new Set([...(this.config.fixture ? ["fixture"] : ["live"]), ...files.filter(f => f !== "live")])];
  }

  private load(name?: string | null): Loaded {
    const setName = name || this.defaultSet;
    const cached = this.loaded.get(setName);
    if (cached) return cached;
    let loaded: Loaded;
    if (setName === "live" && !this.config.fixture) {
      loaded = {
        set: { name: "live", live: true, inventory: "", stateDir: this.config.dir, root: null, macHost: this.config.macHost, harnessStore: globalHarnessDir(), box: this.liveBox, macTrash: "~/work/skills-review/trash" },
        skills: this.liveSkills,
      };
    } else {
      if (!/^[\w.-]+$/.test(setName) || setName === "live") throw new NotFound(`No review set ${setName}.`);
      const file = join(this.config.dir, "sets", `${setName}.json`);
      if (this.config.fixture && setName === "fixture" && !existsSync(file)) writeFixtureSet(join(this.config.dir, "fixture-root"), { reviewDir: this.config.dir, name: "fixture" });
      let raw: Record<string, unknown>;
      try {
        raw = obj(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        throw new NotFound(`No review set ${setName}: ${file} does not read as JSON.`);
      }
      const inventory = str(raw.inventory);
      const stateDir = str(raw.stateDir);
      const root = str(raw.root);
      const harnessStore = str(raw.harnessStore);
      if (!inventory || !stateDir || !root || !harnessStore) throw new NotFound(`No review set ${setName}: ${file} needs inventory, stateDir, root and harnessStore.`);
      const box = str(raw.box) ?? this.liveBox;
      loaded = {
        set: { name: setName, live: false, inventory: resolve(inventory), stateDir: resolve(stateDir), root: resolve(root), macHost: str(raw.macHost), harnessStore: resolve(harnessStore), box, macTrash: join(resolve(stateDir), "mac-trash") },
        skills: new Skills({ inventory: resolve(inventory), scanner: null }, box),
      };
    }
    this.loaded.set(setName, loaded);
    return loaded;
  }

  /**
   * Hard guard against a destructive action on shared state: a set other than live only touches paths under its own root, so a test, the
   * fixture or a walk on live :5184 never removes a real skill. Answers why it refused, or null.
   */
  private outside(set: ReviewSet, ...paths: (string | null)[]): string | null {
    if (set.root === null) return null;
    const bad = paths.find(path => path !== null && !under(set.root!, path));
    return bad ? `Refused: ${bad} is outside the set's root ${set.root}.` : null;
  }

  private serial<R>(set: ReviewSet, task: () => Promise<R>): Promise<R> {
    const before = this.chains.get(set.name) ?? Promise.resolve();
    const next = before.then(task, task);
    this.chains.set(set.name, next.catch(() => undefined));
    return next;
  }

  // Rows and items

  private async rows(skills: Skills): Promise<{ inventory: string | null; raw: Row[]; error: string | null }> {
    const read = await skills.rawRows();
    return { inventory: read.generatedAt, raw: read.rows.flatMap(row => rowOf(row) ?? []), error: read.error };
  }

  /** Items by id: each id with a remove or merge copy, plus each id the state holds steps for, with the rows a rescan dropped from its steps. */
  private group(rows: Row[], state: SetState): [string, Row[]][] {
    const byItem = new Map<string, Row[]>();
    for (const row of rows) byItem.set(row.item, [...(byItem.get(row.item) ?? []), row]);
    const out: [string, Row[]][] = [];
    if (state.items) for (const id of Object.keys(state.items)) if (id.startsWith(DB_ITEM)) byItem.delete(id);
    for (const [id, list] of byItem) {
      const record = state.items[id];
      if (!list.some(row => row.verdict === "remove" || row.verdict === "merge") && !record) continue;
      out.push([id, this.withSteps(list, record)]);
    }
    for (const [id, record] of Object.entries(state.items)) if (!byItem.has(id) && !id.startsWith(DB_ITEM)) out.push([id, this.withSteps([], record)]);
    return out;
  }

  private withSteps(rows: Row[], record: ItemRecord | undefined): Row[] {
    const seen = new Set(rows.map(row => row.id));
    return [...rows, ...Object.values(record?.ops ?? {}).filter(op => !seen.has(op.row.id)).map(op => op.row)];
  }

  private async itemRows(loaded: Loaded, id: string): Promise<{ rows: Row[]; generatedAt: string | null }> {
    const { inventory, raw } = await this.rows(loaded.skills);
    const state = await this.state(loaded.set);
    const found = this.group(raw, state).find(([itemId]) => itemId === id);
    if (!found) throw new NotFound(`No review item ${id} in set ${loaded.set.name}.`);
    return { rows: found[1], generatedAt: inventory };
  }

  private actionOf(row: Row, record: ItemRecord | undefined): { action: ReviewAction; foldInto: string | null } {
    const op = record?.ops[row.id];
    if (live(op)) return { action: op!.action, foldInto: op!.foldInto };
    const override = record?.decision?.overrides[row.id];
    if (override) return override;
    const proposed = proposedOf(row);
    return { action: proposed, foldInto: proposed === "fold" ? row.mergeInto : null };
  }

  private summary(id: string, rows: Row[], record: ItemRecord | undefined): ReviewItemSummary {
    const acting = rows.filter(row => this.actionOf(row, record).action !== "keep");
    const first = rows[0]!;
    return {
      id, title: first.title, unit: first.unit, group: first.group, status: record?.status ?? "pending", copies: rows.length, toAct: acting.length,
      bytes: acting.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0), boxes: [...new Set(rows.map(row => row.box))].sort(),
      queued: Object.values(record?.ops ?? {}).some(op => op.state === "queued"),
    };
  }

  /** The copy each name's others are diffed against: a copy to keep, from this box first, then sieun-pi's, then one the scanner marked keep. */
  private keepers(rows: Row[], record: ItemRecord | undefined, box: string): Set<string> {
    const out = new Set<string>();
    const names = new Set(rows.map(row => row.name));
    for (const name of names) {
      const keep = rows.filter(row => row.name === name && this.actionOf(row, record).action === "keep");
      const rank = (row: Row) => (row.dir.startsWith("harness:") ? 8 : 0) + (row.box === box ? 0 : 4) + (row.family.startsWith("sieun-pi") ? 0 : 2) + (row.verdict === "keep" ? 0 : 1);
      keep.sort((a, b) => rank(a) - rank(b));
      if (keep[0]) out.add(keep[0].id);
    }
    return out;
  }

  private async view(loaded: Loaded, id: string): Promise<ReviewItem> {
    const { set } = loaded;
    const { rows } = await this.itemRows(loaded, id);
    const state = await this.state(set);
    const record = state.items[id];
    const keepers = this.keepers(rows, record, set.box);
    const want = new Map(rows.map(row => [row.id, this.actionOf(row, record)]));
    const plans = await this.plan(set, rows, want, record ?? { status: "pending", decision: null, stamp: null, ops: {} });
    const queue = await this.queue(set);
    const copyRows: ReviewCopy[] = rows.map(row => {
      const op = record?.ops[row.id];
      const target = want.get(row.id)!;
      const step = queue.queue.find(s => s.item === id && s.copy === row.id);
      const stateOf: CopyState = op && (live(op) || target.action !== "keep") ? op.state : "pending";
      return {
        id: row.id, box: row.box, path: row.dir, family: row.family, kind: row.kind, sizeBytes: row.sizeBytes, lines: row.lines, files: row.files,
        lastUse: row.lastUse, uses30d: row.uses30d, lastChange: row.lastChange, proposed: proposedOf(row), action: target.action, foldInto: target.foldInto,
        reason: row.reason || (keepers.has(row.id) ? "The copy the others are compared with." : "The scanner proposes nothing for this copy."),
        how: op && live(op) && op.how !== "place" ? op.how : plans.get(row.id)?.how ?? "none", keeper: keepers.has(row.id), state: stateOf,
        note: step ? (op?.note ?? null) : op?.note ?? plans.get(row.id)?.note ?? null,
      };
    });
    const texts = new Map<string, string | null>();
    await Promise.all(rows.map(async row => texts.set(row.id, await this.textOf(set, row, record?.ops[row.id]))));
    const diffs: Record<string, string | null> = {};
    const shown: Record<string, string | null> = {};
    for (const row of rows) {
      const keeper = rows.find(other => other.name === row.name && keepers.has(other.id));
      const text = texts.get(row.id) ?? null;
      if (keeper && keeper.id !== row.id) {
        const base = texts.get(keeper.id) ?? null;
        const diff = base === null || text === null ? null : unifiedDiff(base, text, `${keeper.box}:${keeper.path}`, `${row.box}:${row.path}`);
        diffs[row.id] = diff;
        if (diff === "") shown[row.id] = text === null ? null : text.slice(0, 4000);
      } else {
        shown[row.id] = text === null ? null : text.slice(0, 4000);
      }
    }
    const description = rows.find(row => keepers.has(row.id))?.description || rows.find(row => row.description)?.description || "";
    return { ...this.summary(id, rows, record), description, copyRows, diffs, texts: shown, decision: record?.decision ?? null };
  }

  /** A copy's text: the text the scanner carried, the entry in its harness store, its file here, or its backup once a step moved it. */
  private async textOf(set: ReviewSet, row: Row, op: Op | undefined): Promise<string | null> {
    if (row.text !== null) return row.text;
    const ref = harnessRef(row);
    if (ref) {
      const entry = readState(set.harnessStore, "global").entries[ref.kind][ref.id];
      if (entry) return entry.content;
      if (!op?.backup) return null;
      return readFile(op.backup, "utf8").then(text => (JSON.parse(text) as HarnessEntry).content, () => null);
    }
    if (row.box !== set.box) return null;
    const read = (path: string) => readFile(path, "utf8").catch(() => null);
    const here = await read(row.path);
    if (here !== null || !op?.backup) return here;
    return read(join(op.backup, relative(row.dir, row.path)));
  }

  // Plans and steps

  /** How each copy's action runs from where it lives. A Mac copy at the repo path a git copy here removes follows that commit. */
  private async plan(set: ReviewSet, rows: Row[], want: Map<string, { action: ReviewAction }>, record: ItemRecord): Promise<Map<string, { how: ReviewHow; repo: string | null; rel: string | null; note: string | null; follows?: string }>> {
    const out = new Map<string, { how: ReviewHow; repo: string | null; rel: string | null; note: string | null; follows?: string }>();
    for (const row of rows) {
      const action = want.get(row.id)?.action ?? "keep";
      const op = record.ops[row.id];
      const how = op?.how;
      if (live(op) && op!.action === action && how && how !== "place") out.set(row.id, { how, repo: op!.repo, rel: op!.rel, note: op!.note });
      else if (action === "keep") out.set(row.id, { how: "none", repo: null, rel: null, note: null });
      else if (action === "fold") out.set(row.id, { how: "fold-job", repo: null, rel: null, note: null });
      else if (harnessRef(row)) out.set(row.id, { how: "harness", repo: null, rel: null, note: null });
      else if (row.box === set.box) out.set(row.id, { ...(await this.tracked(row.dir)), note: null });
      else out.set(row.id, { how: "trash", repo: null, rel: null, note: row.box === MAC ? null : `No way to reach ${row.box} from here.` });
    }
    for (const row of rows) {
      const plan = out.get(row.id)!;
      if (row.box !== MAC || plan.how !== "trash") continue;
      const lead = rows.find(other => {
        const p = out.get(other.id)!;
        return p.how === "git" && p.rel && want.get(other.id)?.action === "delete" && row.dir.endsWith(`/${p.rel}`) && p.rel.includes("/");
      });
      if (lead) {
        const rel = out.get(lead.id)!.rel!;
        out.set(row.id, { how: "follows-git", repo: null, rel, note: `The Mac's checkout drops ${rel} when it pulls the commit that removes it on ${set.box}.`, follows: lead.id });
      }
    }
    return out;
  }

  private async tracked(dir: string): Promise<{ how: ReviewHow; repo: string | null; rel: string | null }> {
    if (!this.gitCache.has(dir)) {
      const repo = checkoutOf(dir);
      let found: { repo: string; rel: string } | null = null;
      if (repo) {
        const rel = relative(repo, dir);
        const files = await git(repo, ["ls-files", "--", rel]).catch(() => "");
        if (files) found = { repo, rel };
      }
      this.gitCache.set(dir, found);
    }
    const found = this.gitCache.get(dir);
    return found ? { how: "git", repo: found.repo, rel: found.rel } : { how: "trash", repo: null, rel: null };
  }

  private backupOf(set: ReviewSet, item: string, record: ItemRecord, row: Row): string {
    // A file name is at most 255 bytes (NAME_MAX), so the item part of the folder name stays under 120.
    const slug = item.replace(/[^\w.-]+/g, "-").slice(0, 120);
    return join(set.stateDir, "trash", `${record.stamp}-${slug}`, row.box, row.dir.startsWith("harness:") ? row.dir.replace(/:/g, "/") + ".json" : row.dir);
  }

  private async apply(set: ReviewSet, item: string, record: ItemRecord, op: Op): Promise<void> {
    const row = op.row;
    op.backup = this.backupOf(set, item, record, row) + (op.how === "place" ? ".placed" : "");
    try {
      if (op.how === "place") await (op.row.box === set.box ? this.applyPlace(set, op) : this.queueMac(set, item, op, "apply"));
      else if (op.how === "fold-job") await this.applyFold(set, item, op);
      else if (op.how === "follows-git") {
        op.state = "applied";
        op.note = `The Mac's checkout drops ${op.rel} when it pulls${op.commit ? ` ${op.commit.slice(0, 8)}` : " the commit that removes it"}.`;
        op.backup = null;
      } else if (op.how === "harness") await this.applyHarness(set, op);
      else if (op.how === "git") await this.applyGit(set, item, op);
      else if (row.box === set.box) await this.applyTrash(set, op);
      else await this.queueMac(set, item, op, "apply");
    } catch (error) {
      op.state = "failed";
      op.note = message(error);
    }
    await this.logMove(set, item, op, "apply");
  }

  private async reverse(set: ReviewSet, item: string, record: ItemRecord, copy: string): Promise<void> {
    const op = record.ops[copy]!;
    try {
      if (op.state === "queued") {
        const cancelled = await this.cancelMacStep(set, item, copy, "apply", op, "undone");
        if (!cancelled) await this.queueMac(set, item, op, "undo");
      } else if (op.how === "place") await (op.row.box === set.box ? this.undoPlace(set, op) : this.queueMac(set, item, op, "undo"));
      else if (op.how === "fold-job") await this.undoFold(set, item, op);
      else if (op.how === "follows-git") {
        op.state = "undone";
        op.note = "The Mac's checkout gets the path back when it pulls the restore commit.";
      } else if (op.how === "harness") await this.undoHarness(set, op);
      else if (op.how === "git") await this.undoGit(set, item, op);
      else if (op.row.box === set.box) await this.undoTrash(set, op);
      else await this.queueMac(set, item, op, "undo");
    } catch (error) {
      op.state = "failed";
      op.note = `Undo failed: ${message(error)}`;
    }
    await this.logMove(set, item, op, "undo");
  }

  private async applyTrash(set: ReviewSet, op: Op): Promise<void> {
    const refused = this.outside(set, op.row.dir);
    if (refused) throw new Error(refused);
    const backup = op.backup!;
    if (present(op.row.dir)) {
      await mkdir(dirname(backup), { recursive: true });
      await rm(backup, { recursive: true, force: true });
      await move(op.row.dir, backup);
    } else if (!present(backup)) {
      if (!op.absentOk) throw new Error(`${op.row.dir} is not there, and no backup holds it.`);
      op.backup = null;
      op.state = "applied";
      op.note = "Nothing was there to remove.";
      return;
    }
    op.state = "applied";
    op.note = null;
  }

  private async undoTrash(set: ReviewSet, op: Op): Promise<void> {
    const refused = this.outside(set, op.row.dir);
    if (refused) throw new Error(refused);
    if (!present(op.row.dir) && !(op.absentOk && (!op.backup || !present(op.backup)))) {
      if (!op.backup || !present(op.backup)) throw new Error(`No backup of ${op.row.dir} at ${op.backup}.`);
      await mkdir(dirname(op.row.dir), { recursive: true });
      await move(op.backup, op.row.dir);
    }
    op.state = "undone";
    op.note = null;
  }

  /** Makes the link or copy a skills DB install wants; a link or folder already there as wanted counts as done. */
  private async applyPlace(set: ReviewSet, op: Op): Promise<void> {
    const place = op.place!;
    const refused = this.outside(set, op.row.dir, place.mode === "copy" ? place.from : null);
    if (refused) throw new Error(refused);
    if (present(op.row.dir)) {
      const same = place.mode === "link" ? lstatSync(op.row.dir).isSymbolicLink() && readlinkSync(op.row.dir) === place.from : !lstatSync(op.row.dir).isSymbolicLink();
      if (!same) throw new Error(`${op.row.dir} already holds something else.`);
    } else {
      await mkdir(dirname(op.row.dir), { recursive: true });
      if (place.mode === "link") await symlink(place.from, op.row.dir);
      else await cp(place.from, op.row.dir, { recursive: true, errorOnExist: true, force: false });
    }
    op.state = "applied";
    op.note = null;
  }

  /** Takes a placed link or copy away into the backup, so a redo or a look at it later still finds it. */
  private async undoPlace(set: ReviewSet, op: Op): Promise<void> {
    const refused = this.outside(set, op.row.dir);
    if (refused) throw new Error(refused);
    if (present(op.row.dir)) {
      await mkdir(dirname(op.backup!), { recursive: true });
      await rm(op.backup!, { recursive: true, force: true });
      await move(op.row.dir, op.backup!);
    }
    op.state = "undone";
    op.note = null;
  }

  private async applyGit(set: ReviewSet, item: string, op: Op): Promise<void> {
    const repo = op.repo!;
    const rel = op.rel!;
    const refused = this.outside(set, op.row.dir, repo);
    if (refused) throw new Error(refused);
    const backup = op.backup!;
    const files = (await git(repo, ["ls-files", "--", rel])).split("\n").filter(Boolean);
    if (!files.length) {
      if (existsSync(op.row.dir) && !existsSync(backup)) throw new Error(`${rel} is not tracked in ${repo} any more.`);
      op.state = "applied";
      return;
    }
    if (existsSync(op.row.dir)) {
      await rm(backup, { recursive: true, force: true });
      await mkdir(dirname(backup), { recursive: true });
      await cp(op.row.dir, backup, { recursive: true });
    }
    const lines = [
      `chore(skills): remove ${rel} (skills review)`, "",
      `The owner approved it in the skills review app on sw factory, set ${set.name}, item ${item}.`, ...(op.row.reason ? [`Reason: ${op.row.reason}`] : []),
      // sieun-pi's commit-msg hook refuses a commit that deletes more than 20 tracked files unless it says so on purpose.
      ...(files.length > 20 ? ["", `Deletes: ${files.length} files on purpose`] : []),
    ];
    try {
      await git(repo, ["rm", "-r", "-q", "--", rel]);
      await git(repo, ["commit", "-q", "-m", lines.join("\n"), "--", rel]);
    } catch (error) {
      await git(repo, ["reset", "-q", "--", rel]).catch(() => undefined);
      await git(repo, ["checkout", "--", rel]).catch(() => undefined);
      throw error;
    }
    op.commit = await git(repo, ["rev-parse", "HEAD"]);
    await rm(op.row.dir, { recursive: true, force: true });
    op.state = "applied";
    op.note = await git(repo, ["push", "-q", "origin", "HEAD"]).then(() => null, error => `Push failed, so commit ${op.commit!.slice(0, 8)} stays local: ${message(error)}`);
  }

  private async undoGit(set: ReviewSet, item: string, op: Op): Promise<void> {
    const repo = op.repo!;
    const rel = op.rel!;
    const refused = this.outside(set, op.row.dir, repo);
    if (refused) throw new Error(refused);
    const tracked = await git(repo, ["ls-files", "--", rel]);
    if (!tracked) {
      if (op.commit) await git(repo, ["checkout", `${op.commit}^`, "--", rel]);
      if (op.backup && existsSync(op.backup)) await cp(op.backup, op.row.dir, { recursive: true, force: false, errorOnExist: false });
      await git(repo, ["add", "--", rel]);
    }
    const staged = await run("git", ["-C", repo, "diff", "--cached", "--quiet", "--", rel]).then(() => false, () => true);
    op.note = null;
    if (staged) {
      await git(repo, ["commit", "-q", "-m", `chore(skills): restore ${rel} (skills review undo)\n\nThe owner undid item ${item} in the skills review app on sw factory, set ${set.name}.`, "--", rel]);
      const sha = await git(repo, ["rev-parse", "HEAD"]);
      op.note = await git(repo, ["push", "-q", "origin", "HEAD"]).then(() => null, error => `Push failed, so restore commit ${sha.slice(0, 8)} stays local: ${message(error)}`);
    }
    op.state = "undone";
  }

  private async applyHarness(set: ReviewSet, op: Op): Promise<void> {
    const ref = harnessRef(op.row)!;
    const refused = this.outside(set, set.harnessStore);
    if (refused) throw new Error(refused);
    if (!op.row.globalStore) throw new Error("Only notes in Prime's global harness store are removed here.");
    const backup = op.backup!;
    await mkdir(dirname(backup), { recursive: true });
    const removed = await updateState(set.harnessStore, "global", state => {
      const entry = state.entries[ref.kind][ref.id];
      if (!entry) return false;
      writeFileSync(backup, JSON.stringify(entry, null, 2) + "\n");
      delete state.entries[ref.kind][ref.id];
      return true;
    });
    if (!removed && !existsSync(backup)) throw new Error(`No ${ref.kind} entry ${ref.id} in ${set.harnessStore}, and no backup holds it.`);
    op.state = "applied";
    op.note = null;
  }

  private async undoHarness(set: ReviewSet, op: Op): Promise<void> {
    const ref = harnessRef(op.row)!;
    const refused = this.outside(set, set.harnessStore);
    if (refused) throw new Error(refused);
    const entry = JSON.parse(await readFile(op.backup!, "utf8")) as HarnessEntry;
    await updateState(set.harnessStore, "global", state => {
      if (state.entries[ref.kind][ref.id]) return false;
      state.entries[ref.kind][ref.id] = entry;
      return true;
    });
    op.state = "undone";
    op.note = null;
  }

  private async applyFold(set: ReviewSet, item: string, op: Op): Promise<void> {
    const text = await this.textOf(set, op.row, undefined);
    if (text !== null) {
      await mkdir(dirname(op.backup!), { recursive: true });
      await writeFile(op.backup!, text);
    } else op.backup = null;
    const line = { at: now(), set: set.name, item, copy: op.row.id, box: op.row.box, path: op.row.dir, foldInto: op.foldInto, reason: op.row.reason, backup: op.backup, kind: "fold" };
    await mkdir(set.stateDir, { recursive: true });
    await appendFile(join(set.stateDir, "folds.jsonl"), JSON.stringify(line) + "\n");
    if (set.live) {
      await this.hooks.fold([
        `[skills review] The owner approved a fold in the skills review app (item ${item}).`,
        `Fold the copy ${op.row.box}:${op.row.dir} into ${op.foldInto}: move its lines that the target lacks into the target, then delete the copy.`,
        `Why: ${op.row.reason || "the scanner proposed it."}`,
        op.backup ? `A backup of its text is at ${op.backup}.` : "",
        `The item and its diff open at #/settings/skills/review?set=${set.name}&item=${encodeURIComponent(item)}.`,
      ].filter(Boolean).join("\n"), `skills-review:${set.name}:${item}:${op.row.id}:fold:${op.at}`);
      op.note = "Sent to agent factory's work thread.";
    } else {
      op.note = "Logged to folds.jsonl; a set other than live messages no agent.";
    }
    op.state = "applied";
  }

  private async undoFold(set: ReviewSet, item: string, op: Op): Promise<void> {
    await appendFile(join(set.stateDir, "folds.jsonl"), JSON.stringify({ at: now(), set: set.name, item, copy: op.row.id, box: op.row.box, path: op.row.dir, foldInto: op.foldInto, kind: "cancel" }) + "\n");
    if (set.live) {
      await this.hooks.fold([
        `[skills review] The owner undid the fold of ${op.row.box}:${op.row.dir} into ${op.foldInto} (item ${item}).`,
        "Drop that fold. If you already moved lines or deleted the copy, revert the target edit and put the copy back" + (op.backup ? ` from ${op.backup}.` : "."),
      ].join("\n"), `skills-review:${set.name}:${item}:${op.row.id}:cancel:${now()}`);
    }
    op.state = "undone";
    op.note = set.live ? "Cancel sent to agent factory's work thread." : null;
  }

  // The Mac queue

  private async queueMac(set: ReviewSet, item: string, op: Op, kind: "apply" | "undo"): Promise<void> {
    if (op.row.box !== MAC) throw new Error(`No way to reach ${op.row.box} from here.`);
    const refused = this.outside(set, op.row.dir);
    if (refused) throw new Error(refused);
    const queue = await this.queue(set);
    const backup = kind === "apply" ? `${set.macTrash}/${relative(join(set.stateDir, "trash"), op.backup!)}` : op.backup!;
    op.backup = backup;
    queue.queue = queue.queue.filter(step => !(step.item === item && step.copy === op.row.id));
    queue.queue.push({ item, copy: op.row.id, kind, dir: op.row.dir, backup, at: now(), ...(op.place ? { place: op.place } : {}), ...(op.absentOk ? { absentOk: true } : {}) });
    await this.saveQueue(set, queue);
    op.state = "queued";
    op.note = set.macHost ? (kind === "apply" ? "Waits for the Mac." : "Waits for the Mac to put it back.") : "Waits for the Mac; this set names no Mac host.";
  }

  /** Drops a queued step of `kind` for the copy, which never ran, and sets the copy to `to`. Answers whether there was one. */
  private async cancelMacStep(set: ReviewSet, item: string, copy: string, kind: "apply" | "undo", op: Op, to: CopyState): Promise<boolean> {
    const queue = await this.queue(set);
    const found = queue.queue.find(step => step.item === item && step.copy === copy && step.kind === kind);
    if (!found) return false;
    queue.queue = queue.queue.filter(step => step !== found);
    await this.saveQueue(set, queue);
    op.state = to;
    op.note = kind === "apply" ? "Never ran on the Mac." : null;
    return true;
  }

  /** Runs the Mac queue now and again each minute while it holds steps. */
  private kickMac(set: ReviewSet): void {
    if (this.timers.has(set.name) || !set.macHost) return;
    const tick = async () => {
      let left = 0;
      try {
        left = await this.serial(set, () => this.runMac(set));
      } catch (error) {
        this.hooks.log(`skills review ${set.name}: the Mac queue did not run: ${message(error)}`);
        left = 1;
      }
      this.timers.delete(set.name);
      if (left > 0) this.schedule(set, tick, MAC_RETRY_MS);
    };
    this.schedule(set, tick, 0);
  }

  private schedule(set: ReviewSet, tick: () => Promise<void>, ms: number): void {
    const timer = setTimeout(() => void tick(), ms);
    timer.unref();
    this.timers.set(set.name, timer);
  }

  private async runMac(set: ReviewSet): Promise<number> {
    const queue = await this.queue(set);
    if (!queue.queue.length || !set.macHost) return queue.queue.length;
    const state = await this.state(set);
    for (const step of [...queue.queue]) {
      const dir = quote(step.dir);
      const backup = macPath(step.backup);
      const here = `{ [ -e "$d" ] || [ -L "$d" ]; }`;
      const kept = `{ [ -e "$b" ] || [ -L "$b" ]; }`;
      const put = step.place?.mode === "copy" ? `cp -R ${quote(step.place.from)} "$d"` : `ln -s ${quote(step.place?.from ?? "")} "$d"`;
      const script = step.place
        ? step.kind === "apply"
          ? `d=${dir}; if ! ${here}; then mkdir -p "$(dirname "$d")" && ${put}; fi`
          : `d=${dir}; b=${backup}; if ${here}; then mkdir -p "$(dirname "$b")" && rm -rf "$b" && mv "$d" "$b"; fi`
        : step.kind === "apply"
          ? `d=${dir}; b=${backup}; if ${here}; then mkdir -p "$(dirname "$b")" && rm -rf "$b" && mv "$d" "$b"; elif ! ${kept}; then ${step.absentOk || step.item.startsWith(DB_ITEM) ? "exit 0" : `echo "$d is not there, and no backup holds it." >&2; exit 3`}; fi`
          : `d=${dir}; b=${backup}; if ! ${here}; then if ${kept}; then mkdir -p "$(dirname "$d")" && mv "$b" "$d"; else ${step.absentOk || step.item.startsWith(DB_ITEM) ? "exit 0" : `echo "No backup at $b." >&2; exit 3`}; fi; fi`;
      const outcome = await run("ssh", [...SSH, set.macHost, script]).then(() => ({ code: 0, error: "" }), (error: { code?: unknown }) => ({ code: typeof error.code === "number" ? error.code : 255, error: message(error) }));
      queue.checkedAt = now();
      if (outcome.code === 255) {
        queue.online = false;
        break;
      }
      queue.online = true;
      queue.queue = queue.queue.filter(s => s !== step);
      const op = state.items[step.item]?.ops[step.copy];
      if (op) {
        op.state = outcome.code === 0 ? (step.kind === "apply" ? "applied" : "undone") : "failed";
        op.note = outcome.code === 0 ? null : step.kind === "undo" ? `Undo failed: ${outcome.error}` : outcome.error;
        await this.logMove(set, step.item, op, step.kind);
      }
      await this.saveState(set, state);
      await this.saveQueue(set, queue);
      this.hooks.broadcast({ type: "skills-review", set: set.name, id: step.item });
    }
    await this.saveQueue(set, queue);
    this.hooks.broadcast({ type: "skills-review", set: set.name, id: null });
    return queue.queue.length;
  }

  // Files

  private async state(set: ReviewSet): Promise<SetState> {
    const raw = await readFile(join(set.stateDir, "state.json"), "utf8").then(text => obj(JSON.parse(text)), () => obj(null));
    return { items: obj(raw.items) as SetState["items"] };
  }

  private async saveState(set: ReviewSet, state: SetState): Promise<void> {
    await writeAtomic(join(set.stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  private async queue(set: ReviewSet): Promise<MacQueue> {
    const raw = await readFile(join(set.stateDir, "mac-queue.json"), "utf8").then(text => obj(JSON.parse(text)), () => obj(null));
    return { queue: Array.isArray(raw.queue) ? (raw.queue as MacStep[]) : [], online: typeof raw.online === "boolean" ? raw.online : null, checkedAt: str(raw.checkedAt) };
  }

  private async saveQueue(set: ReviewSet, queue: MacQueue): Promise<void> {
    await writeAtomic(join(set.stateDir, "mac-queue.json"), JSON.stringify(queue, null, 2) + "\n");
  }

  private async logMove(set: ReviewSet, item: string, op: Op, kind: "apply" | "undo"): Promise<void> {
    const line = {
      at: now(), set: set.name, item, copy: op.row.id, box: op.row.box, path: op.row.dir, how: op.how, step: kind, action: op.action, foldInto: op.foldInto,
      backup: op.backup, result: op.state === "failed" ? `failed: ${op.note}` : op.state, commit: op.commit,
    };
    await mkdir(set.stateDir, { recursive: true });
    await appendFile(join(set.stateDir, "moves.jsonl"), JSON.stringify(line) + "\n");
  }
}

const done = (status: ItemStatus): boolean => status !== "pending" && status !== "undone";

function diskState(state: CopyState): DiskResult["state"] {
  return state === "applied" || state === "queued" || state === "failed" || state === "undone" ? state : "pending";
}

/** A skills DB step as a review row: the folder is the step's path, and the id carries the step's place in its item. */
function stepRow(item: string, step: DiskStep, index: number): Row {
  return {
    id: `${step.box}:${step.path}#${index}`, name: step.name, box: step.box, path: step.path.startsWith("harness:") ? step.path : join(step.path, "SKILL.md"), dir: step.path,
    family: "", kind: "ours", group: null, description: "", sizeBytes: null, lines: null, files: null, lastUse: null, uses30d: null, lastChange: null, verdict: null,
    reason: step.kind === "fold" ? step.reason : "Asked through the skills DB (sw skills).", mergeInto: step.kind === "fold" ? step.into : null, actionable: false, text: null,
    entryId: null, globalStore: step.path.startsWith("harness:"), item, title: step.name, unit: "skill",
  };
}

function counts(items: ReviewItemSummary[]): ReviewReport["counts"] {
  const of = (status: ItemStatus) => items.filter(item => item.status === status).length;
  return { items: items.length, pending: of("pending") + of("undone"), approved: of("approved"), kept: of("kept"), skipped: of("skipped") };
}

/** Moves a file or folder, copying across file systems. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/** A decide body as the client sends it, checked at the edge. */
export function decideBody(raw: unknown): ReviewDecideBody {
  const body = obj(raw);
  const set = str(body.set);
  const id = str(body.id);
  if (!set || !id) throw new ReviewRefused("A decision names its set and item id as set and id.");
  if (body.action !== "approve" && body.action !== "keep" && body.action !== "skip") throw new ReviewRefused("A decision's action is approve, keep or skip.");
  const overrides: NonNullable<ReviewDecideBody["overrides"]> = {};
  for (const [copy, value] of Object.entries(obj(body.overrides))) {
    const change = obj(value);
    if (!(REVIEW_ACTIONS as readonly string[]).includes(String(change.action))) throw new ReviewRefused(`An override's action is one of ${REVIEW_ACTIONS.join(", ")}.`);
    overrides[copy] = { action: change.action as ReviewAction, foldInto: str(change.foldInto) };
  }
  return { set, id, action: body.action, overrides };
}

export function undoBody(raw: unknown): ReviewUndoBody {
  const body = obj(raw);
  const set = str(body.set);
  const id = str(body.id);
  if (!set || !id) throw new ReviewRefused("An undo names its set and item id as set and id.");
  return { set, id };
}

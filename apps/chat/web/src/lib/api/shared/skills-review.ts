/**
 * Skills review: the cleanup proposals from the skills inventory (server/skills.ts), one item per screen for the owner to decide, as the
 * review route at #/settings/skills/review reads it through /api/skills/review (server/skills-review.ts). The owner asked for it on For you
 * todo t4 (msg mwqukzwx): "하나씩 리뷰할 수 있게 mini webapp 만들어주라". An item is one skill name, or one plugin for plugin skills, with every
 * copy of it on every box. His Approve applies that item's actions at once, with a backup and a log line, and Undo puts it back.
 *
 * A review set is one inventory plus the folder that holds its decisions, backups and log. `live` is the real inventory with
 * ~/work/skills-review; any other set is a throwaway fixture registered under ~/work/skills-review/sets/<name>.json, whose actions may only
 * touch paths under its own root, so a walk never applies a real item.
 */

/** What a copy's approval does. `delete` removes it with a backup, `fold` hands it to a fold job that moves its unique lines into `foldInto`. */
export const REVIEW_ACTIONS = ["delete", "fold", "keep"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * How the server carries out a copy's action, from where the copy lives:
 * `trash` moves the folder into the set's trash; `git` removes it from its repo with a commit of only that path, pushed to the current branch;
 * `harness` deletes the entry from the harness store it came from; `fold-job` hands the fold to agent factory's work thread; `follows-git`
 * means a checkout fed by another copy's commit, such as the Mac's sieun-pi, so nothing runs on it; `none` means nothing to do (keep).
 */
export type ReviewHow = "trash" | "git" | "harness" | "fold-job" | "follows-git" | "none";

/** Where one copy's applied action stands. `queued` waits for its box, such as the Mac while it is offline. */
export type CopyState = "pending" | "queued" | "applied" | "failed" | "undone";

export type ReviewCopy = {
  /** The inventory row id. */
  id: string;
  box: string;
  path: string;
  /** The scanner's family, such as `claude-plugin`, `harness-memory`, `sieun-pi` or `repo:slack-green`. */
  family: string;
  kind: string;
  sizeBytes: number | null;
  lines: number | null;
  files: number | null;
  /** The newest use any transcript shows, ISO, or null when none in the scan window. */
  lastUse: string | null;
  uses30d: number | null;
  lastChange: { sha: string; at: string; subject: string } | null;
  /** The scanner's verdict as an action, and the action the owner set with Change target, which wins. */
  proposed: ReviewAction;
  action: ReviewAction;
  foldInto: string | null;
  reason: string;
  how: ReviewHow;
  /** True for the copy the others are diffed against, the one we keep. */
  keeper: boolean;
  state: CopyState;
  /** Why the last apply or undo failed, or what a queued step waits for. */
  note: string | null;
};

export type ItemStatus = "pending" | "approved" | "kept" | "skipped" | "undone";

/** The list row: enough for the progress count and the jump list. */
export type ReviewItemSummary = {
  /** `skill:<name>` or `plugin:<plugin>`. */
  id: string;
  title: string;
  unit: "skill" | "plugin";
  group: string | null;
  status: ItemStatus;
  copies: number;
  /** Copies whose action is delete or fold. */
  toAct: number;
  bytes: number;
  boxes: string[];
  /** True when one of its copies waits in the Mac queue. */
  queued: boolean;
};

/** GET /api/skills/review/item?set=&id=: one item with every copy and, per copy, a unified diff against the keeper. */
export type ReviewItem = ReviewItemSummary & {
  description: string;
  copyRows: ReviewCopy[];
  /** Unified diff of each non-keeper copy's text against the keeper's, by copy id; null when either text is not readable here. */
  diffs: Record<string, string | null>;
  /** Copy text where no keeper exists or the diff is empty, by copy id, first 4000 characters. */
  texts: Record<string, string | null>;
  /** The last decision, for Undo. */
  decision: ReviewDecision | null;
};

export type ReviewDecision = { at: string; action: "approve" | "keep" | "skip"; overrides: Record<string, { action: ReviewAction; foldInto: string | null }> };

/** GET /api/skills/review?set=: the set, every item in review order (pending first, then by copies to act), and the Mac queue. */
export type ReviewReport = {
  set: string;
  sets: string[];
  generatedAt: string | null;
  items: ReviewItemSummary[];
  counts: { items: number; pending: number; approved: number; kept: number; skipped: number };
  mac: { host: string | null; online: boolean | null; checkedAt: string | null; queued: number };
};

/** POST /api/skills/review/decide: the owner's choice for one item. Overrides change one copy's action or fold target before it applies. */
export type ReviewDecideBody = {
  set: string;
  id: string;
  action: "approve" | "keep" | "skip";
  overrides?: Record<string, { action: ReviewAction; foldInto?: string | null }>;
};

/** POST /api/skills/review/undo: puts the item's last decision back, restoring every applied copy from its backup. */
export type ReviewUndoBody = { set: string; id: string };

/** What decide and undo answer: the item after the change, and the list counts. */
export type ReviewResult = { item: ReviewItem; counts: ReviewReport["counts"] };

/** The live event the server sends when an item or the Mac queue changes, so an open page reads the item again. */
export type ReviewEvent = { type: "skills-review"; set: string; id: string | null };

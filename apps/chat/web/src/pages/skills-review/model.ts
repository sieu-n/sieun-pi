/** Pure helpers for the skills review screen: the key map, the item order, the owner's edits as decide overrides, the diff lines and the words of the counts. */
import type { ItemStatus, ReviewAction, ReviewCopy, ReviewDecideBody, ReviewItem, ReviewItemSummary, ReviewReport } from "$lib/api/shared/skills-review";

/** The owner's commands on the review screen, each with its key, as the buttons show them. */
export const COMMANDS = {
  approve: { key: "a", label: "Approve" },
  skip: { key: "s", label: "Skip" },
  keep: { key: "e", label: "Keep" },
  undo: { key: "u", label: "Undo" },
  target: { key: "t", label: "Change target" },
  next: { key: "j", label: "Next" },
  previous: { key: "k", label: "Previous" },
} as const;
export type Command = keyof typeof COMMANDS;

const BY_KEY = new Map<string, Command>(Object.entries(COMMANDS).map(([command, { key }]) => [key, command as Command]));

/** True when the key goes to a field, so a letter types instead of running a command. */
function typing(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  return (target as Element).closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

/** The command a keydown runs, or null for a key with a modifier, a key typed into a field, or a key no command has. */
export function commandFor(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target"> & { isComposing?: boolean }): Command | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || typing(event.target)) return null;
  return BY_KEY.get(event.key) ?? null;
}

/** The item the address names when the report has it, else the first pending one, else the first. */
export function pickItem(items: readonly ReviewItemSummary[], wanted: string | undefined): string | null {
  if (wanted && items.some(item => item.id === wanted)) return wanted;
  return (items.find(item => item.status === "pending") ?? items[0])?.id ?? null;
}

/** The item `step` places away in review order, or null past either end. */
export function neighbor(items: readonly ReviewItemSummary[], id: string | null, step: 1 | -1): string | null {
  const at = items.findIndex(item => item.id === id);
  return items[at + step]?.id ?? null;
}

/** The next pending item after `id` in review order, wrapping to the start, or null when none waits. */
export function nextPending(items: readonly ReviewItemSummary[], id: string): string | null {
  const at = items.findIndex(item => item.id === id);
  const order = [...items.slice(at + 1), ...items.slice(0, Math.max(0, at))];
  return order.find(item => item.status === "pending")?.id ?? null;
}

/** One copy's action as the owner set it with Change target. */
export type Edit = { action: ReviewAction; foldInto: string };

export const editOf = (copy: ReviewCopy): Edit => ({ action: copy.action, foldInto: copy.foldInto ?? "" });

/** The edits that differ from what the server holds, as decide overrides; a fold target goes along only with a fold. */
export function overridesOf(copies: readonly ReviewCopy[], edits: Readonly<Record<string, Edit>>): NonNullable<ReviewDecideBody["overrides"]> {
  const out: NonNullable<ReviewDecideBody["overrides"]> = {};
  for (const copy of copies) {
    const edit = edits[copy.id];
    if (!edit) continue;
    const foldInto = edit.action === "fold" ? edit.foldInto.trim() || null : null;
    if (edit.action !== copy.action || foldInto !== (copy.action === "fold" ? copy.foldInto : null)) out[copy.id] = { action: edit.action, foldInto };
  }
  return out;
}

/** Why Approve cannot run with these edits yet, such as a fold with no target, or null. */
export function editProblem(copies: readonly ReviewCopy[], edits: Readonly<Record<string, Edit>>): string | null {
  for (const copy of copies) {
    const edit = edits[copy.id] ?? editOf(copy);
    if (edit.action === "fold" && !edit.foldInto.trim()) return `Name the skill ${copy.box} ${copy.path} folds into.`;
  }
  return null;
}

export type DiffLine = { kind: "add" | "del" | "hunk" | "meta" | "same"; text: string };

/** A unified diff split into lines, each with its kind for the colors. */
export function diffLines(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  return lines.map(text => {
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("\\")) return { kind: "meta", text };
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "same", text };
  });
}

/** Added and removed line counts of a unified diff. */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter(line => line.kind === "add").length, removed: lines.filter(line => line.kind === "del").length };
}

export const STATUS_TONE: Record<ItemStatus, "neutral" | "success" | "outline" | "warning" | "accent"> = {
  pending: "outline",
  approved: "success",
  kept: "accent",
  skipped: "neutral",
  undone: "warning",
};

export const ACTION_LABEL: Record<ReviewAction, string> = { delete: "Delete", fold: "Fold", keep: "Keep" };

/** "Delete", "Fold into tsc-check" or "Keep", for a copy's action. */
export function actionText(action: ReviewAction, foldInto: string | null): string {
  return action === "fold" ? `Fold into ${foldInto ?? "?"}` : ACTION_LABEL[action];
}

/** The Mac line: whether the Mac answers and how many copies wait for it. */
export function macText(mac: ReviewReport["mac"]): string {
  const queued = mac.queued === 0 ? "" : `, ${mac.queued} ${mac.queued === 1 ? "copy" : "copies"} queued`;
  if (mac.online === null) return `Mac state unknown${queued}`;
  return `${mac.online ? "Mac online" : "Mac offline"}${queued}`;
}

/** "Applied 2, queued for Mac 1", the states of an item's copies after a decision, for the toast. */
export function statesText(item: ReviewItem): string {
  const names: Record<ReviewCopy["state"], string> = { applied: "applied", queued: "queued for Mac", failed: "failed", undone: "undone", pending: "pending" };
  const counts = new Map<string, number>();
  for (const copy of item.copyRows) if (!copy.keeper) counts.set(names[copy.state], (counts.get(names[copy.state]) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${n} ${name}`).join(", ");
}

/** "12 KB", "840 B" or "?" for a size. */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return "?";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** "just now", "12 min ago", "3 h ago" or "4 days ago". */
export function agoText(at: number, now: number): string {
  if (!Number.isFinite(at)) return "at an unknown time";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

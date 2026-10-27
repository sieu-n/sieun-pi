export type StepStatus = "todo" | "doing" | "done" | "blocked" | "dropped";

export interface Step {
  id: string;
  text: string;
  status: StepStatus;
  children: Step[];
  job?: string;
  sessionId?: string;
  note?: string;
  waitFor?: string;
  waitUntil?: string;
  awaitingGo?: boolean;
  requirements?: { text: string; status: string; evidence?: string; note?: string }[];
}

export interface Ask {
  id: string;
  text: string;
  done: boolean;
  from: "agent" | "owner";
  at: string;
  reply?: string;
  choices?: string[];
  step?: string;
  links?: { label: string; target: string }[];
}

export const STATUS_LABEL: Record<StepStatus, string> = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked", dropped: "Dropped" };

/** The panel's status groups for top-level steps, in reading order. Done and dropped steps sit behind the "Show done" fold. */
export const OPEN_GROUPS: readonly StepStatus[] = ["doing", "todo", "blocked"];

export const isFinished = (step: Pick<Step, "status">): boolean => step.status === "done" || step.status === "dropped";

export interface Progress { done: number; total: number }

/** Every step under `steps` that is not dropped, and how many of them are done. */
export function progressOf(steps: readonly Step[]): Progress {
  const progress = { done: 0, total: 0 };
  const walk = (list: readonly Step[]) => {
    for (const step of list) {
      if (step.status !== "dropped") {
        progress.total++;
        if (step.status === "done") progress.done++;
      }
      walk(step.children);
    }
  };
  walk(steps);
  return progress;
}

export const stepProgress = (step: Step): Progress | null => (step.children.length ? progressOf(step.children) : null);

/** "waits for review until Oct 9, 2:30 PM", or null when the step waits on nothing. */
export function waitWords(step: Pick<Step, "waitFor" | "waitUntil">, now = Date.now()): string | null {
  const text = step.waitFor?.trim();
  const at = step.waitUntil ? Date.parse(step.waitUntil) : NaN;
  const sameYear = Number.isFinite(at) && new Date(at).getFullYear() === new Date(now).getFullYear();
  const when = Number.isFinite(at)
    ? new Date(at).toLocaleString(undefined, { ...(sameYear ? {} : { year: "numeric" }), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  if (!text && !when) return null;
  return `waits${text ? ` for ${text}` : ""}${when ? ` until ${when}` : ""}`;
}

/** The owner chip text: the job the chat wrote, or the first 8 characters of a bare session id. */
export function ownerName(step: Pick<Step, "job" | "sessionId">): string | null {
  const name = step.job?.trim() || step.sessionId;
  if (!name) return null;
  return /^[0-9a-f]{8}-/.test(name) ? name.slice(0, 8) : name;
}

export type Row =
  | { kind: "step"; step: Step; depth: number; parent: string }
  | { kind: "finished"; parent: string; depth: number; count: number; shown: boolean };

export interface TreeView {
  open: (id: string) => boolean;
  showDone: (parent: string) => boolean;
}

/** The rows of one step list in reading order: children show when their parent is open, and finished steps show only when "Show done" is on for their parent. */
export function treeRows(steps: readonly Step[], view: TreeView, root: string): Row[] {
  const rows: Row[] = [];
  const visit = (list: readonly Step[], depth: number, parent: string) => {
    const shown = view.showDone(parent);
    let hidden = 0;
    for (const step of list) {
      if (isFinished(step)) hidden++;
      if (!shown && isFinished(step)) continue;
      rows.push({ kind: "step", step, depth, parent });
      if (step.children.length && view.open(step.id)) visit(step.children, depth + 1, step.id);
    }
    if (hidden) rows.push({ kind: "finished", parent, depth, count: hidden, shown });
  };
  visit(steps, 0, root);
  return rows;
}

/** The top-level steps of each open group, then the finished ones. */
export function planGroups(plan: readonly Step[]): { status: StepStatus; steps: Step[] }[] {
  return OPEN_GROUPS.map(status => ({ status, steps: plan.filter(step => step.status === status) })).filter(group => group.steps.length > 0);
}

export const finishedSteps = (plan: readonly Step[]): Step[] => plan.filter(isFinished);

/** The path from the top to `id`, or null when the plan has no such step. */
export function pathTo(plan: readonly Step[], id: string): Step[] | null {
  for (const step of plan) {
    if (step.id === id) return [step];
    const below = pathTo(step.children, id);
    if (below) return [step, ...below];
  }
  return null;
}

export function findStep(plan: readonly Step[], id: string): Step | null {
  return pathTo(plan, id)?.at(-1) ?? null;
}

/** Every step with children, so "Collapse all" can fold them. */
export function parentIds(plan: readonly Step[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly Step[]) => {
    for (const step of list) {
      if (step.children.length) ids.push(step.id);
      walk(step.children);
    }
  };
  walk(plan);
  return ids;
}

/** A step note cut to its first sentence or first line, with `cut` true when the rest is hidden. */
export function firstSentence(note: string): { text: string; cut: boolean } {
  const whole = note.trim();
  const line = whole.split(/\n/, 1)[0]!.trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(line);
  const sentence = match ? match[0] : line;
  const words = sentence.split(/\s+/).filter(Boolean);
  const text = words.length > 25 ? words.slice(0, 25).join(" ").replace(/[,;:.]+$/, "") + "\u2026" : sentence;
  return { text, cut: text !== whole };
}

/** Open asks newest first, and the done ones newest first behind the "Done (n)" fold. */
export function groupAsks<T extends Pick<Ask, "done" | "at">>(asks: readonly T[]): { open: T[]; done: T[] } {
  const byTime = (left: T, right: T) => right.at.localeCompare(left.at);
  return { open: asks.filter(ask => !ask.done).sort(byTime), done: asks.filter(ask => ask.done).sort(byTime) };
}

/** An ask the owner has not answered: from the chat, open, with no reply. */
export const unanswered = (ask: Pick<Ask, "from" | "done" | "reply">): boolean => ask.from === "agent" && !ask.done && !ask.reply;

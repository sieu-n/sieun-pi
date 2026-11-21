import type { Step, StepStatus } from "./model";

/** What the plan's Find field and Filter menu ask for; a step shows when it meets every part that is set. */
export interface PlanFilter {
  query: string;
  statuses: ReadonlySet<StepStatus>;
  needsGo: boolean;
  /** An owner name as the row's chip shows it, or null for anyone. */
  owner: string | null;
}

export const NO_FILTER: PlanFilter = { query: "", statuses: new Set(), needsGo: false, owner: null };

export const filterActive = (filter: PlanFilter): boolean =>
  filter.query.trim() !== "" || filter.statuses.size > 0 || filter.needsGo || filter.owner !== null;

/** How many parts of the Filter menu are set, for its "Filter 2" label; the Find text is not counted. */
export const menuCount = (filter: PlanFilter): number => filter.statuses.size + (filter.needsGo ? 1 : 0) + (filter.owner !== null ? 1 : 0);

export interface FilterContext {
  awaitingGo: ReadonlySet<string>;
  ownerOf: (step: Step) => string | null;
}

/**
 * Every word of the query, in any case, is in the step's text, id, wait or owner, which its row shows. Notes stay out: on 11-21 "release"
 * matched 144 of agent factory's 197 steps through their notes and 3 through their text, and the panel shows no notes.
 */
function matchesQuery(step: Step, words: readonly string[], owner: string | null): boolean {
  if (!words.length) return true;
  const hay = [step.id, step.text, step.waitFor ?? "", owner ?? ""].join("\n").toLowerCase();
  return words.every(word => hay.includes(word));
}

function matches(step: Step, filter: PlanFilter, words: readonly string[], context: FilterContext): boolean {
  const owner = context.ownerOf(step);
  if (filter.statuses.size && !filter.statuses.has(step.status)) return false;
  if (filter.needsGo && !context.awaitingGo.has(step.id)) return false;
  if (filter.owner !== null && owner !== filter.owner) return false;
  return matchesQuery(step, words, owner);
}

export interface FilteredPlan {
  /** The plan cut to the matching steps and the steps above them, each with only the children that lead to a match. */
  plan: Step[];
  /** The ids of the steps that match; the others in `plan` show only as the path to one. */
  matches: Set<string>;
  /** Every step in the whole plan, for "12 of 59 steps". */
  total: number;
}

/** The plan as the filter shows it: matching steps keep the path above them, as Slack Lists keeps a sub-item's parent row. */
export function filterPlan(plan: readonly Step[], filter: PlanFilter, context: FilterContext): FilteredPlan {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = new Set<string>();
  let total = 0;
  const cut = (list: readonly Step[]): Step[] => list.flatMap(step => {
    total++;
    const children = cut(step.children);
    const hit = matches(step, filter, words, context);
    if (hit) hits.add(step.id);
    return hit || children.length ? [{ ...step, children }] : [];
  });
  return { plan: cut(plan), matches: hits, total };
}

/** The owners on the plan with how many steps each has, most first, for the Filter menu's Owner list. */
export function planOwners(plan: readonly Step[], ownerOf: (step: Step) => string | null): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  const walk = (list: readonly Step[]) => {
    for (const step of list) {
      const owner = ownerOf(step);
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      walk(step.children);
    }
  };
  walk(plan);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Every step that has children in a cut plan, so the filtered view opens the path to each match. */
export function pathIds(plan: readonly Step[]): string[] {
  return plan.flatMap(step => (step.children.length ? [step.id, ...pathIds(step.children)] : []));
}

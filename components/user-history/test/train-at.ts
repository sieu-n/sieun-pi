import { parseTrain, type Train } from "../src/checkin-load.ts";

/**
 * The CI cache as it read at `now`, rebuilt from the runs of a later read (`runs`) shifted `shiftMs` earlier, plus `extra` runs: a run created
 * after `now` is left out, and a run not yet ended then was in progress, last updated when it started.
 */
export function trainAt(runs: Readonly<Record<string, { run: Record<string, unknown> }>>, now: number, shiftMs = 0, extra: Record<string, unknown>[] = []): Train {
  const all = [...Object.values(runs).map(({ run }) => run), ...extra];
  const read = Object.fromEntries(all.flatMap(run => {
    const at = (field: string) => Date.parse(String(run[field])) - shiftMs;
    const created = at("created_at");
    if (created > now) return [];
    const ended = run.status === "completed" && at("updated_at") <= now;
    const started = Number.isFinite(at("run_started_at")) && at("run_started_at") <= now ? at("run_started_at") : created;
    return [[String(run.id), { run: { ...run, created_at: new Date(created).toISOString(), updated_at: new Date(ended ? at("updated_at") : started).toISOString(),
      status: ended ? "completed" : "in_progress", conclusion: ended ? run.conclusion : null } }]];
  }));
  return parseTrain({ fetchedAt: new Date(now).toISOString(), runs: read })!;
}

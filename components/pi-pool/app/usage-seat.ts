/**
 * Usage windows for a Claude account whose usage body has a 5h window and no weekly one, as a team seat's does.
 * tokenmaxxing's read rejects such a body ("usage.get_incomplete"), so usage-read.ts lands these windows instead.
 * Returns null for any other body, so a full body always goes through tokenmaxxing.
 */
type Limit = { utilization?: unknown; resets_at?: unknown };
type Window = { name: string | null; usedPercentage: number; resetsAt: number | null; windowSeconds: number; sampledAt: number };

const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const instant = (value: unknown): number | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);

export function seatWindows(body: unknown, at: number): Window[] | null {
  if (!isRecord(body) || body.seven_day != null || !isRecord(body.five_hour)) return null;
  const five = body.five_hour as Limit;
  if (typeof five.utilization !== "number") return null;
  const models = (Array.isArray(body.limits) ? body.limits : []).flatMap((row): Window[] => {
    if (!isRecord(row) || row.kind !== "weekly_scoped" || typeof row.percent !== "number") return [];
    const name = isRecord(row.scope) && isRecord(row.scope.model) ? row.scope.model.display_name : null;
    return typeof name === "string" ? [{ name, usedPercentage: row.percent, resetsAt: instant(row.resets_at), windowSeconds: WEEK_S, sampledAt: at }] : [];
  });
  return [{ name: null, usedPercentage: five.utilization, resetsAt: instant(five.resets_at), windowSeconds: FIVE_HOURS_S, sampledAt: at }, ...models];
}

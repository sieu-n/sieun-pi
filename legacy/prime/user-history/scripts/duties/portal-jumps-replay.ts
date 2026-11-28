import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BASELINE_DAYS, type PairDay, pairJumps, pairsSql } from "./customer-api-failures.ts";
import { grafanaClient, readGrafanaAuth, sqlRows } from "./estate-reads.ts";
import { type Charge, FUNCTION_JUMP_TIMES, JUMP_DAYS, VERCEL_TEAM, billedDays, functionJump, isJump } from "./portal-status-board.ts";
import { vercelToken } from "./vercel-login.ts";

/**
 * Replays the two jump checks over stored days and prints one line per day (`node --import tsx scripts/duties/portal-jumps-replay.ts [days]`).
 * function_time_jump (d6) reads Vercel's billing charges of the last 40 days. org_operation_jumps (d4) reads every org's keyed calls of the
 * last `days` UTC days (default 21) from prod ClickHouse. portal-jumps.replay.md holds the output that picked FUNCTION_JUMP_TIMES, JUMP_TIMES
 * and JUMP_FLOOR.
 */

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

async function main(): Promise<void> {
  const now = Date.now();
  const response = await fetch(`https://api.vercel.com/v1/billing/charges?teamId=${VERCEL_TEAM}&from=${new Date(now - 40 * DAY_MS).toISOString()}&to=${new Date(now).toISOString()}`,
    { headers: { Authorization: `Bearer ${await vercelToken()}` } });
  const charges = (await response.text()).split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Charge);
  const days = billedDays(charges, now).slice(1);
  console.log(`d6 function_time_jump at ${FUNCTION_JUMP_TIMES} times, billing day, instance hours, median of the 7 before, times, flagged`);
  for (let end = JUMP_DAYS; end <= days.length; end += 1) {
    const jump = functionJump(days.slice(0, end))!;
    console.log(`${jump.day.start.slice(0, 10)} ${jump.hours} ${jump.medianHours} ${jump.medianHours ? Math.round((100 * jump.hours) / jump.medianHours) / 100 : "-"} ${isJump(jump) ? "jump" : ""}`);
  }
  const span = Number(process.argv[2] ?? 21);
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const query = grafanaClient(fetch, await readGrafanaAuth(), now, AbortSignal.timeout(110_000));
  const rows: PairDay[] = (await sqlRows(query, "estate_ch_prod", pairsSql({ start: iso(end - (span - BASELINE_DAYS) * DAY_MS), end: iso(end) })))
    .map(row => ({ day: String(row.day), org: String(row.org), endpoint: String(row.endpoint), calls: Number(row.calls), failed5xx: Number(row.failed5xx) }));
  console.log("d4 org_operation_jumps, UTC day, pairs read, jumps: org operation kind value median");
  for (let day = end - (span - BASELINE_DAYS) * DAY_MS; day < end; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    const { jumps, pairs } = pairJumps(rows, date);
    console.log(`${date} ${pairs} ${jumps.length} ${jumps.map(jump => `${jump.org} ${jump.endpoint} ${jump.kind} ${jump.value} ${jump.median}`).join("; ")}`);
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();

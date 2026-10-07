import { DatabaseSync } from "node:sqlite";
import type { UsageCall, UsageSource } from "../shared/usage.ts";

/**
 * SQLite sources, opened read-only and read whole: both hold aggregates or small tables on this Mac.
 *
 * Hermes Agent `~/.hermes/state.db`, port of sessions/hermes.rs: per-model rows from `session_model_usage` (summed per
 * session, model and billing provider), and session totals from `sessions` for sessions without such rows. Each row
 * is one "call" dated at the session start; cost is the actual cost, else Hermes' estimate.
 *
 * OpenCode `~/.local/share/opencode/opencode.db`, port of sessions/opencode_schema.rs (v1 `message` and v2
 * `session_message` queries): one call per assistant message with `tokens`, dated at `time.created`.
 */
/** Same rule as ParserSpec.version: bump it when what these readers emit changes. */
export const databaseVersion = "1";
type Row = Record<string, unknown>;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "bigint" ? Number(value) : 0;
const str = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value : null;

function rows(db: DatabaseSync, sql: string): Row[] | null {
  try { return db.prepare(sql).all() as Row[]; } catch { return null; }
}

export function readDatabase(source: UsageSource, path: string): UsageCall[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); } catch { return []; }
  try { return source === "hermes" ? hermes(db) : source === "opencode" ? opencode(db) : []; }
  finally { db.close(); }
}

const hermesPerModel = `
  SELECT smu.session_id, smu.model, smu.billing_provider, s.started_at,
    SUM(smu.input_tokens) AS input, SUM(smu.output_tokens) AS output, SUM(smu.cache_read_tokens) AS cache_read,
    SUM(smu.cache_write_tokens) AS cache_write, SUM(smu.reasoning_tokens) AS reasoning,
    SUM(COALESCE(NULLIF(smu.actual_cost_usd, 0), smu.estimated_cost_usd, 0)) AS cost
  FROM session_model_usage smu JOIN sessions s ON s.id = smu.session_id
  WHERE smu.model IS NOT NULL AND TRIM(smu.model) != ''
  GROUP BY smu.session_id, smu.model, smu.billing_provider, s.started_at`;
const hermesTotals = `
  SELECT id AS session_id, model, billing_provider, started_at, input_tokens AS input, output_tokens AS output,
    cache_read_tokens AS cache_read, cache_write_tokens AS cache_write, reasoning_tokens AS reasoning,
    COALESCE(actual_cost_usd, estimated_cost_usd, 0) AS cost
  FROM sessions WHERE model IS NOT NULL AND TRIM(model) != ''`;

function hermes(db: DatabaseSync): UsageCall[] {
  const calls: UsageCall[] = [];
  const covered = new Set<string>();
  const call = (row: Row, callId: string): UsageCall => ({
    source: "hermes", callId, sessionId: str(row.session_id), endedAt: Math.round(num(row.started_at) * 1000), startedAt: null,
    provider: str(row.billing_provider), model: str(row.model), input: num(row.input), output: num(row.output), cacheRead: num(row.cache_read),
    cacheWrite: num(row.cache_write), reasoning: num(row.reasoning), costUsd: num(row.cost) > 0 ? num(row.cost) : null, cwd: null,
  });
  const used = (c: UsageCall) => c.input + c.output + c.cacheRead + c.cacheWrite + c.reasoning > 0 || (c.costUsd ?? 0) > 0;
  for (const row of rows(db, hermesPerModel) ?? []) {
    const c = call(row, `hermes:${String(row.session_id)}:${String(row.model)}:${str(row.billing_provider) ?? "<null>"}`);
    if (!used(c)) continue;
    covered.add(String(row.session_id));
    calls.push(c);
  }
  for (const row of rows(db, hermesTotals) ?? []) {
    if (covered.has(String(row.session_id))) continue;
    const c = call(row, String(row.session_id));
    if (used(c)) calls.push(c);
  }
  return calls;
}

function opencode(db: DatabaseSync): UsageCall[] {
  const found = rows(db, `SELECT m.id, m.session_id, m.data FROM message m WHERE json_extract(m.data, '$.role') = 'assistant' AND json_extract(m.data, '$.tokens') IS NOT NULL`) ?? [];
  const v2 = rows(db, `SELECT sm.id, sm.session_id, sm.data FROM session_message sm WHERE sm.type = 'assistant' AND json_extract(sm.data, '$.tokens') IS NOT NULL`) ?? [];
  const calls: UsageCall[] = [];
  for (const row of [...found, ...v2]) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(String(row.data)) as Record<string, unknown>; } catch { continue; }
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (!tokens || typeof tokens !== "object") continue;
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    const model = data.model as Record<string, unknown> | undefined;
    const timeInfo = (data.time ?? {}) as Record<string, unknown>;
    const created = num(timeInfo.created), completed = num(timeInfo.completed);
    const ms = (value: number) => value > 0 && value < 1e11 ? value * 1000 : value;
    if (created <= 0) continue;
    calls.push({
      source: "opencode", callId: String(row.id), sessionId: str(row.session_id), endedAt: ms(completed || created), startedAt: completed ? ms(created) : null,
      provider: str(data.providerID) ?? str(model?.providerID), model: str(data.modelID) ?? str(model?.id) ?? "unknown",
      input: num(tokens.input), output: num(tokens.output), cacheRead: num(cache.read), cacheWrite: num(cache.write), reasoning: num(tokens.reasoning),
      costUsd: num(data.cost) > 0 ? num(data.cost) : null, cwd: null,
    });
  }
  return calls;
}

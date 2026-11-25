/**
 * Duty precheck: the skills tables in the chat db stay sound (owner, dm_duty-check-1125201916d2-2/p1, 11-25, msg mwwkh7tn: "go through the
 * skills tables in the chat db, tell me if anything looks off, and keep an eye on them from now on").
 *
 * It opens chat.sqlite read-only and reads four numbers:
 * - scan_age_h, hours since the oldest box's last good skill scan (the server scans each box every 60 min, SCAN_EVERY_MS in server/skills.ts);
 * - orphan_rows, installs or verdicts whose skill row is gone, and verdicts whose copy (box:path) is gone from skill_copies;
 * - hash_mismatch, installs whose applied_hash differs from source_hash, a NULL source_hash counted as a mismatch;
 * - problem_verdicts, broken verdicts plus verdicts whose action is remove.
 * It also keeps the last run's counts per table and per verdict rule in a state file and flags each one that changed.
 *
 * Usage: OUTPUT_FILE=<file> node scripts/duties/skills-tables.ts [--db <chat.sqlite>] [--state <json>]
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

type Flag = { kind: string; sig: string; excerpt: string };
type Counts = Record<string, number>;

const SCAN_TARGET_H = 2;

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

export function readSkillsTables(db: DatabaseSync, now = Date.now()): { metrics: Record<string, number>; counts: Counts; flagged: Flag[] } {
  const one = (sql: string): number => num((db.prepare(sql).get() as Record<string, unknown> | undefined)?.n);
  const flagged: Flag[] = [];

  const scans = db.prepare("SELECT box, ok, error, last_ok_at FROM skill_scans").all() as { box: string; ok: unknown; error: string | null; last_ok_at: string | null }[];
  let scanAge = scans.length === 0 ? Number.POSITIVE_INFINITY : 0;
  for (const s of scans) {
    const age = s.last_ok_at ? (now - Date.parse(s.last_ok_at)) / 3_600_000 : Number.POSITIVE_INFINITY;
    scanAge = Math.max(scanAge, age);
    if (num(s.ok) !== 1) flagged.push({ kind: "scan_failed", sig: `scan:${s.box}`, excerpt: `The last skill scan of ${s.box} failed: ${s.error ?? "no error text"}.` });
    if (age > SCAN_TARGET_H) flagged.push({ kind: "scan_stale", sig: `scan_age:${s.box}`, excerpt: `${s.box} had no good skill scan for ${age.toFixed(1)} h (last ${s.last_ok_at ?? "never"}).` });
  }

  const orphanInstalls = one("SELECT count(*) AS n FROM skill_installs i WHERE NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = i.skill_id)");
  const orphanVerdicts = one("SELECT count(*) AS n FROM skill_verdicts v WHERE NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = v.skill_id)");
  const orphanCopyVerdicts = one(
    "SELECT count(*) AS n FROM skill_verdicts v WHERE v.copy_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM skill_copies c WHERE c.box || ':' || c.path = v.copy_id)",
  );
  for (const [n, what] of [[orphanInstalls, "installs name a skill row that is gone"], [orphanVerdicts, "verdicts name a skill row that is gone"], [orphanCopyVerdicts, "verdicts name a copy that is gone from skill_copies"]] as const) {
    if (n > 0) flagged.push({ kind: "orphan_rows", sig: `orphan:${what}`, excerpt: `${n} ${what}.` });
  }

  const nullSource = one("SELECT count(*) AS n FROM skill_installs WHERE source_hash IS NULL");
  const mismatch = one("SELECT count(*) AS n FROM skill_installs WHERE source_hash IS NULL OR applied_hash IS NULL OR applied_hash <> source_hash");
  if (mismatch > 0) flagged.push({ kind: "hash_mismatch", sig: "hash_mismatch", excerpt: `${mismatch} installs have an applied_hash that differs from source_hash, ${nullSource} of them with no source_hash.` });

  const broken = one("SELECT count(*) AS n FROM skill_verdicts WHERE rule = 'broken'");
  const remove = one("SELECT count(*) AS n FROM skill_verdicts WHERE action = 'remove'");

  const counts: Counts = {};
  for (const t of ["skills", "skill_installs", "skill_copies", "skill_verdicts", "skill_use", "skill_use_box", "skill_moves"]) counts[`rows:${t}`] = one(`SELECT count(*) AS n FROM ${t}`);
  for (const r of db.prepare("SELECT rule || '/' || action AS k, count(*) AS n FROM skill_verdicts GROUP BY 1").all() as { k: string; n: unknown }[]) counts[`verdict:${r.k}`] = num(r.n);
  counts["uses:total"] = one("SELECT coalesce(sum(uses), 0) AS n FROM skill_use");

  return {
    metrics: {
      scan_age_h: Number.isFinite(scanAge) ? Math.round(scanAge * 10) / 10 : 9999,
      orphan_rows: orphanInstalls + orphanVerdicts + orphanCopyVerdicts,
      hash_mismatch: mismatch,
      problem_verdicts: broken + remove,
    },
    counts,
    flagged,
  };
}

/** One flag per count that moved since the last run; a skill_use total that did not move is flagged too, since use counts should grow. */
export function changes(before: Counts | undefined, after: Counts): Flag[] {
  if (!before) return [];
  const flags: Flag[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k] ?? 0;
    const b = after[k] ?? 0;
    if (a !== b && k !== "uses:total") flags.push({ kind: "changed", sig: `changed:${k}`, excerpt: `${k} went from ${a} to ${b} since the last run.` });
  }
  if ((before["uses:total"] ?? 0) === (after["uses:total"] ?? 0)) flags.push({ kind: "uses_flat", sig: "uses_flat", excerpt: `skill_use's total uses stayed at ${after["uses:total"]} since the last run.` });
  return flags;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string", default: join(homedir(), ".pi/agent/chat/chat.sqlite") },
      state: { type: "string", default: join(homedir(), ".pi/agent/agents/duty-check-1125201916d2-2/skills-tables-last.json") },
    },
  });
  const db = new DatabaseSync(values.db as string, { readOnly: true });
  const result = readSkillsTables(db);
  db.close();
  const statePath = values.state as string;
  const before = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { counts: Counts }).counts : undefined;
  result.flagged.push(...changes(before, result.counts));
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ at: new Date().toISOString(), counts: result.counts }, null, 1));
  const json = JSON.stringify({ metrics: result.metrics, flagged: result.flagged }, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

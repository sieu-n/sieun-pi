/**
 * The answer check for the staging Convex route /api/test/cleanup (auto-sns-agent convex/apiPortal/portalHttp.ts, keys.cleanupTestOrg), which the
 * portal-parity and portal-billing duties call to delete each test org they seed. Until 10-28 neither duty read the answer, and that day a
 * code-cut sweep removed the route, so every run would have left its seeded orgs, keys and balances on staging with nothing flagged.
 */

/** The fewest rows a cleanup deletes for one seeded test org: /api/test/seed makes one key, and one balance row when it is given a
 *  balance. Charges add balance shard rows (convex/apiPortal/balances.ts), so a busy org has more. Read on staging on 2026-10-28: a seeded
 *  org with no calls answered keys 1 and balances 1, and a second cleanup of it 0 and 0; each d2 org answered keys 1 and balances 17. */
export const SEEDED_ROWS = { keys: 1, balances: 1 } as const;

/** Throws an error naming the org unless the cleanup answered 200 with `ok: true` and deleted at least the rows the seed made. */
export async function checkCleanup(call: Promise<Response>, orgId: string, expected: Readonly<Record<string, number>> = SEEDED_ROWS): Promise<void> {
  const fail = (why: string) => new Error(`staging /api/test/cleanup left test org ${orgId}: ${why}`);
  let response: Response;
  let text: string;
  try {
    response = await call;
    text = await response.text();
  } catch (error) {
    throw fail(`no answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw fail(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  type Body = { ok?: unknown; counts?: Record<string, unknown> } | null;
  let body: Body;
  try { body = JSON.parse(text) as Body; } catch { throw fail(`not JSON: ${text.slice(0, 160)}`); }
  if (body?.ok !== true) throw fail(`ok is not true: ${text.slice(0, 160)}`);
  const deleted = (table: string) => body?.counts?.[table];
  const wrong = Object.entries(expected).filter(([table, least]) => { const count = deleted(table); return typeof count !== "number" || count < least; });
  if (wrong.length) throw fail(`deleted ${wrong.map(([table, least]) => `${table} ${String(deleted(table))} (expected at least ${least})`).join(", ")}`);
}

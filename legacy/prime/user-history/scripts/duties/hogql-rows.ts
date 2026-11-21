/**
 * Every row of a HogQL query, or an error. HogQL cuts a query that has no LIMIT to 100 rows and caps an explicit LIMIT at 50000 rows, the
 * second one silently: on 2026-11-22 `SELECT number FROM numbers(60000)` gave 100 rows with hasMore true, and the same query with LIMIT 60000
 * gave 50000 rows with no hasMore. OFFSET paging is refused with a personal API key (HTTP 400 hogql_query_error, same day). The 100-row cut is
 * how the Slack green numbers duty (d5) read 28 of 51 real signups on 11-22, after a QA run made 170 sg-qa- signups in its 7-day window.
 * So `query` (no LIMIT of its own) runs with LIMIT HOGQL_MAX_ROWS, and a full page throws, which the duty reports as a source error.
 */
export const HOGQL_MAX_ROWS = 50_000;

export async function allRows<Row>(query: string, run: (limited: string) => Promise<Row[]>): Promise<Row[]> {
  const rows = await run(`${query}\nLIMIT ${HOGQL_MAX_ROWS}`);
  if (rows.length >= HOGQL_MAX_ROWS) throw new Error(`HogQL gave its ${HOGQL_MAX_ROWS}-row cap, so rows may be missing: ${query.slice(0, 120)}`);
  return rows;
}

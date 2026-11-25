// The prod otel client behind the Agents card's tok/s and the duties: what it asks Grafana, and how a failed query reaches the caller.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { grafanaOtel, sessionRates } from "../src/usage/otel.ts";

type Asked = { auth: string | undefined; uid: string; sql: string };
/** A Grafana /api/ds/query that answers each query with `answer(sql)` as one table frame, or with `status`. */
async function grafana(answer: (sql: string) => Record<string, unknown[]>, status = 200) {
  const asked: Asked[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const query = (JSON.parse(body) as { queries: { datasource: { uid: string }; rawSql: string }[] }).queries[0]!;
    asked.push({ auth: req.headers.authorization, uid: query.datasource.uid, sql: query.rawSql });
    res.statusCode = status;
    if (status !== 200) { res.end(JSON.stringify({ message: "bad gateway" })); return; }
    const columns = answer(query.rawSql);
    res.end(JSON.stringify({ results: { A: { frames: [{ schema: { fields: Object.keys(columns).map(name => ({ name })) }, data: { values: Object.values(columns) } }] } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const config = join(mkdtempSync(join(tmpdir(), "otel-client-")), "grafana-alerts.json");
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, token: "viewer" }));
  return { asked, otel: grafanaOtel(config), close: () => server.close() };
}

test("the Agents card's rates read Prime's session counters from prod otel, the last minute over the last 24 h", async () => {
  const { asked, otel, close } = await grafana(sql => sql.includes("toInt64(1795593540000)")
    ? { session: ["a"], value: [41.26] }
    : { session: ["a", "b"], value: [30, 12.04] });
  try {
    const rates = await sessionRates(otel, ["a", "b", "a; DROP"], Date.parse("2026-11-25T08:00:00Z"));
    assert.deepEqual(rates, { a: { tps: 41.3, live: true }, b: { tps: 12, live: false } });
    assert.equal(asked.length, 2);
    for (const { auth, uid, sql } of asked) {
      assert.equal(auth, "Bearer viewer");
      assert.equal(uid, "grafana_clickhouse");
      assert.match(sql, /ServiceName = 'prime-agent' AND ResourceAttributes\['deployment\.environment\.name'\] = 'shared'/);
      assert.match(sql, /Attributes\['session'\] IN \('a', 'b'\)/, "an id that is no session id is never asked");
    }
  } finally { close(); }
});

test("a failed otel query throws its status, never answers zeros", async () => {
  const { otel, close } = await grafana(() => ({}), 502);
  try { await assert.rejects(otel.rows("SELECT 1"), { status: 502, message: /^otel query failed: grafana 502/ }); }
  finally { close(); }
});

test("an unreachable Grafana names the network cause, not only fetch failed", async () => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise(resolve => closed.close(resolve));
  const config = join(mkdtempSync(join(tmpdir(), "otel-client-")), "grafana-alerts.json");
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "viewer" }));
  await assert.rejects(grafanaOtel(config).rows("SELECT 1"), { status: 502, message: /^otel query failed: fetch failed \(ECONNREFUSED/ });
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRelay } from "../relay.mjs";

const TOKEN = "t".repeat(40);

async function relayWith(historySocket, t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-history-"));
  writeFileSync(join(dir, "token"), TOKEN);
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "daemon.sock"), roots: [], token: TOKEN, historySocket });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => relay.close());
  return `http://127.0.0.1:${relay.address().port}`;
}

test("/v1/history/<route> reaches the pi-history socket as /v1/<route> after the token check", async t => {
  const dir = mkdtempSync(join(tmpdir(), "relay-history-sock-"));
  const socket = join(dir, "history.sock");
  const asked = [];
  const history = createServer((request, response) => {
    asked.push(request.url);
    response.writeHead(request.url.startsWith("/v1/search") ? 200 : 400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  });
  history.listen(socket);
  await once(history, "listening");
  t.after(() => history.close());
  const base = await relayWith(socket, t);

  const refused = await fetch(`${base}/v1/history/search?q=relay`);
  assert.equal(refused.status, 401);
  assert.deepEqual(asked, [], "no token, no call to pi-history");

  const answer = await fetch(`${base}/v1/history/search?q=relay%20mac&local=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { path: "/v1/search?q=relay%20mac&local=1" });
  const bad = await fetch(`${base}/v1/history/read?ref=x`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bad.status, 400, "pi-history's own status comes back");
});

test("/v1/history/ answers 503 when pi-history is not running", async t => {
  const base = await relayWith(join(tmpdir(), "no-such-history.sock"), t);
  const answer = await fetch(`${base}/v1/history/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(answer.status, 503);
  assert.match((await answer.json()).error, /pi-history does not answer/);
});

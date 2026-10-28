import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRelay } from "../relay.mjs";

const TOKEN = "t".repeat(40);

// d7 on the chat host reads another box's ~/.prime/agent/update-restarts without knowing that box's user (src/prime-update.ts hostUpdateSpans).
test("/v1/file reads a ~/ path as this box's home, inside the roots only", async t => {
  const home = mkdtempSync(join(tmpdir(), "relay-home-"));
  const records = join(home, ".prime/agent/update-restarts");
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, "ctl-1-2.json"), "{\"phase\":\"complete\"}");
  writeFileSync(join(home, "secret"), "no");
  const before = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = before; });
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(home, "daemon.sock"), roots: [records], token: TOKEN });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => relay.close());
  const get = (path) => fetch(`http://127.0.0.1:${relay.address().port}/v1/file?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const list = await get("~/.prime/agent/update-restarts");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).entries.map(entry => entry.name), ["ctl-1-2.json"]);
  assert.equal(await (await get("~/.prime/agent/update-restarts/ctl-1-2.json")).text(), "{\"phase\":\"complete\"}");
  assert.equal((await get("~/secret")).status, 403);
  assert.equal((await get("secret")).status, 403);
});

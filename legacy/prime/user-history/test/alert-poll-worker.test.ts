// Guards 10-19 11:43Z to 11:48:41Z: the alert bridge's Grafana poll did not run for 5 min while the chat service's main thread read 100% busy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startAlertPoll } from "../src/alert-poll.ts";

test("the alert poll and its status file keep their beat while the main thread is blocked", async t => {
  const dir = mkdtempSync(join(tmpdir(), "alert-poll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Grafana runs in its own process, so a blocked main thread here cannot hold its answers.
  const grafana = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end("[]"); })
    .listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port) + "\\n"); });`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => grafana.kill());
  const port = await new Promise<string>(resolve => grafana.stdout.once("data", chunk => resolve(String(chunk).trim())));
  const grafanaConfig = join(dir, "grafana-alerts.json");
  writeFileSync(grafanaConfig, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "t" }));
  mkdirSync(join(dir, "sessions"));
  const statusFile = join(dir, "status.json");
  const poll = startAlertPoll({ grafanaConfig, sessionsDir: join(dir, "sessions"), statusFile, pollMs: 200 }, () => {});
  t.after(() => poll.stop());
  for (let waited = 0; poll.health.record.lastOk === null && waited < 20_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const blockedAt = Date.now();
  while (Date.now() - blockedAt < 3000) { /* the main thread busy, as a stalled chat service's is */ }
  const status = JSON.parse(readFileSync(statusFile, "utf8")) as { ts: string; last_ok: string; health: string };
  assert.ok(Date.parse(status.ts) - blockedAt > 2000, `status written ${Date.parse(status.ts) - blockedAt} ms into a 3000 ms block`);
  assert.ok(Date.parse(status.last_ok) - blockedAt > 2000, `last good poll ${Date.parse(status.last_ok) - blockedAt} ms into the block`);
  assert.equal(status.health, "ok");
  assert.ok(await poll.alerts(), "the main thread gets the newest poll's alerts");
  assert.equal(await poll.alerts(), null, "and gets them only once");
});

// Guards d7's first minute after a chat release: a successor's latency window opened at the first write the running chat passed on, so the
// first watch line after it took the port held its start's own stalls. The 13:50:30Z line on 11-13 read a 13.2 s loop stall and a 7.5 s GC
// from 13:46Z and 13:47Z, minutes before release-ca062aa answered a read, and d7 counted the minute dirty.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SLOW_READ_MS } from "../src/harness-slow.ts";

const fixture = fileURLToPath(new URL("./handoff-fixture.ts", import.meta.url));

const post = (port: number): Promise<string> => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: "/api/x", method: "POST", agent: false }, res => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => { resolve(body); });
  });
  req.on("error", reject);
  req.end("{}");
});

test("a successor's start stalls stay off its first latency line, and it runs a full GC before it takes the port", { timeout: 60_000 }, async t => {
  const old = fork(fixture, [], { execArgv: ["--import", "tsx"], env: { ...process.env, FIXTURE_START_MS: "1500", FIXTURE_STALL_MS: "1500" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let log = "";
  old.stderr!.on("data", chunk => { log += chunk; });
  t.after(() => {
    old.kill("SIGKILL");
    const successor = Number(/started the successor (\d+)/.exec(log)?.[1]);
    if (successor) try { process.kill(successor, "SIGKILL"); } catch { /* gone */ }
  });
  const { port } = await new Promise<{ port: number }>(resolve => old.once("message", value => resolve(value as { port: number })));
  old.send("go");
  const until = Date.now() + 30_000;
  let wrote = false;
  while (Date.now() < until && !/new latency /.test(log)) {
    // A write during the start goes to the successor and opens its latency window, as the owner's sends do on the live chat.
    if (!wrote && /only answers reads/.test(log)) { wrote = true; void post(port); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const latency = JSON.parse(/new latency (.*)/.exec(log)?.[1] ?? "null") as { loopMs: number } | null;
  assert.ok(wrote, log);
  assert.ok((latency?.loopMs ?? 0) < SLOW_READ_MS, `the first line after the take-over read the start's ${latency?.loopMs} ms stall\n${log}`);
  const settled = /took the port .*; a full GC freed -?\d+ MB in \d+ ms first, and the start's longest loop stall of (\d+) ms/.exec(log);
  assert.ok(settled, log);
  assert.ok(Number(settled[1]) >= 1400, `the log names the start's stall it left out: ${settled[1]} ms`);
});

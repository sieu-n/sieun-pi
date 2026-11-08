// Guards d7's restart minutes on us-metal02: a release restart stopped the chat, and the next one answered the port while its own start held its
// main thread. At 13:02:12Z on 11-08 its main thread ran 93 to 100% busy for 11 s after it listened, the owner's
// api/threads/01a11ba8/duties read took 1.1 s with CI on 47 of 80 cores, and d7 counted the minute dirty; 18 of 133 starts from 11-03 to 11-08
// had a read over 1 s in their first 65 s. A reload now starts the next process beside the running one, which answers until it took over.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { descendants, serveArgs } from "../src/chat-handoff.ts";

const fixture = fileURLToPath(new URL("./handoff-fixture.ts", import.meta.url));

const ask = (port: number, method = "GET"): Promise<{ who: string; pid: number; ms: number }> => new Promise((resolve, reject) => {
  const at = performance.now();
  const req = request({ host: "127.0.0.1", port, path: "/api/x", method, agent: false }, res => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => { try { resolve({ ...JSON.parse(body), ms: performance.now() - at }); } catch (error) { reject(error); } });
  });
  req.on("error", reject);
  req.end(method === "GET" ? undefined : "{}");
});

test("a reload hands the port over: the running chat answers while the successor starts, and the successor answers once it took over", { timeout: 60_000 }, async t => {
  const old = fork(fixture, [], { execArgv: ["--import", "tsx"], env: { ...process.env, FIXTURE_START_MS: "3000" }, stdio: ["ignore", "inherit", "pipe", "ipc"] });
  let log = "";
  old.stderr!.on("data", chunk => { log += chunk; });
  t.after(() => { old.kill("SIGKILL"); });
  const { port } = await new Promise<{ port: number }>(resolve => old.once("message", value => resolve(value as { port: number })));
  const exited = new Promise<number | null>(resolve => old.once("exit", code => resolve(code)));
  old.send("go");
  const reads: { who: string; pid: number; ms: number }[] = [];
  let write: { who: string } | undefined;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const read = await ask(port);
    reads.push(read);
    if (reads.length === 10) write = await ask(port, "POST");
    if (read.who === "new" && reads.filter(entry => entry.who === "new").length >= 3) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const before = reads.filter(entry => entry.who === "old");
  assert.ok(before.length >= 10, `the running chat answered ${before.length} reads during the successor's 3 s start\n${log}`);
  assert.ok(Math.max(...before.map(entry => entry.ms)) < 500, `no read waited on the successor's busy start: ${before.map(entry => Math.round(entry.ms)).join(", ")}\n${log}`);
  assert.equal(write?.who, "new", "a write during the hand-over went to the successor, whose loops run");
  const successor = reads.find(entry => entry.who === "new")?.pid;
  if (successor) t.after(() => { try { process.kill(successor, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(reads.at(-1)!.who, "new", log);
  assert.equal(await exited, 0, "the running chat exits once the successor took the port");
  assert.match(log, /handoff: took the port \d+ s after the server was ready, once its first pass ended/);
});

test("the successor runs the serve's own command line, and a hand-over's process sweep spares the successor and all under it", () => {
  assert.deepEqual(serveArgs(["/home/u/.local/node/bin/node", "/home/u/current/src/chat-service-cli.mjs", "serve", "--port", "5182", ""].join("\u0000")),
    ["/home/u/current/src/chat-service-cli.mjs", "serve", "--port", "5182"]);
  const table = new Map([[11, 10], [12, 10], [13, 12], [14, 11], [20, 1]]);
  assert.deepEqual(descendants(10, 12, table).sort(), [11, 14]);
});

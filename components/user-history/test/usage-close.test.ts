// Guards the 10-18 05:27:10Z stop on us-metal02: the chat aborted with SIGABRT ("terminate called after throwing an instance of
// 'Napi::Error'") because its usage worker thread ended while a DuckDB statement ran, which skipped the closes after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageStore } from "../src/usage/store.ts";

/** Runs well over 10 s on 2 DuckDB threads, so it is still in flight when the close comes. */
const LONG_SQL = "SELECT sum(i * i) FROM range(5000000000) t(i)";
type Internals = { exclusive<T>(task: () => Promise<T>): Promise<T>; db: { runAndReadAll(sql: string): Promise<unknown> } };

test("UsageStore.close interrupts the statement in flight and refuses the queued ones", async () => {
  const store = await UsageStore.open(join(mkdtempSync(join(tmpdir(), "usage-close-")), "usage.duckdb"));
  const inner = store as unknown as Internals;
  const long = inner.exclusive(() => inner.db.runAndReadAll(LONG_SQL));
  const queued = store.files();
  await new Promise(resolve => setTimeout(resolve, 300));
  const started = Date.now();
  await store.close();
  assert.ok(Date.now() - started < 2000, `close took ${Date.now() - started} ms`);
  await assert.rejects(long, /INTERRUPT/);
  await assert.rejects(queued, /closing/);
});

const WORKER = `
import { parentPort } from "node:worker_threads";
import { UsageStore } from ${JSON.stringify(new URL("../src/usage/store.ts", import.meta.url).href)};
const store = await UsageStore.open(${JSON.stringify(join(mkdtempSync(join(tmpdir(), "usage-close-")), "usage.duckdb"))});
store.exclusive(() => store.db.runAndReadAll(${JSON.stringify(LONG_SQL)})).catch(() => {});
parentPort.on("message", () => { void store.close().finally(() => process.exit(0)); });
parentPort.postMessage("busy");
`;
const MAIN = `
import { Worker } from "node:worker_threads";
const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(${JSON.stringify(WORKER)})));
worker.on("message", () => setTimeout(() => worker.postMessage({ close: true }), 300));
worker.on("exit", code => process.exit(code));
`;

test("a usage worker closed during a DuckDB statement exits cleanly instead of aborting the process", () => {
  const started = Date.now();
  const run = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", MAIN], { encoding: "utf8", timeout: 60_000 });
  assert.ok(Date.now() - started < 10_000, `the worker took ${Date.now() - started} ms to close`);
  assert.equal(run.signal, null, `signal ${run.signal}: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Napi::Error/);
  assert.equal(run.status, 0, run.stderr);
});
